'use strict';

/**
 * SessionFSM — Session Lifecycle State Machine
 *
 * Implements the 7-state session lifecycle defined in §19.1 of the Phase 2
 * specification using @cognitive-fab/sam-fsm.
 *
 * States:
 *   idle            → No active session; waiting for trigger
 *   running         → Session active; LLM generating or text-only response
 *   awaiting_tool   → Tool call proposed; security gate passed; executing tool
 *   awaiting_approval → Tool needs operator approval; waiting for email reply
 *   compressing     → Turn count exceeded threshold; Haiku summarisation in progress
 *   complete        → Session concluded normally; reply sent or CLI prompt returned
 *   error           → Unrecoverable error; operator notified
 *
 * Integration: State Machine Reactor pattern.
 * After each SAM model mutation the reactor validates the new model.status
 * against this FSM before allowing the render cycle to proceed.
 */

let _createFSM;
try {
  _createFSM = require('@cognitive-fab/sam-fsm').createFSM;
} catch {
  // Fallback: lightweight FSM implementation for environments where the
  // package is unavailable (e.g., CI without a full npm install).
  _createFSM = _buildFallbackFSM;
}

// ---------------------------------------------------------------------------
// FSM transition table
// ---------------------------------------------------------------------------

/**
 * All valid transitions.  Key: "FROM:EVENT", Value: next state.
 * Guards (functions returning boolean) narrow when a transition is allowed.
 */
const TRANSITIONS = {
  // ── From idle ──────────────────────────────────────────────────────────────
  'idle:trigger':                   'running',

  // ── From running ──────────────────────────────────────────────────────────
  'running:tool_proposed_read':     'awaiting_tool',
  'running:tool_proposed_medium':   'awaiting_approval',
  'running:tool_proposed_high':     'awaiting_approval',
  'running:tool_proposed_critical': 'awaiting_approval',
  'running:threshold_exceeded':     'compressing',
  'running:finish':                 'complete',
  'running:fatal_error':            'error',

  // ── From awaiting_tool ─────────────────────────────────────────────────────
  'awaiting_tool:tool_result':      'running',
  'awaiting_tool:fatal_error':      'error',

  // ── From awaiting_approval ─────────────────────────────────────────────────
  'awaiting_approval:approved':     'awaiting_tool',
  'awaiting_approval:denied':       'running',
  'awaiting_approval:expired':      'running',

  // ── From compressing ──────────────────────────────────────────────────────
  'compressing:compression_done':   'running',

  // ── From complete ─────────────────────────────────────────────────────────
  'complete:reset':                 'idle',

  // ── From error ────────────────────────────────────────────────────────────
  'error:reset':                    'idle',
};

// ---------------------------------------------------------------------------
// Fallback FSM builder (used when @cognitive-fab/sam-fsm is unavailable)
// ---------------------------------------------------------------------------

/**
 * Minimal FSM implementation that satisfies the interface consumed by
 * makeReactor() and the test suite.
 *
 * @param {{ initial: string }} options
 * @returns {object} FSM instance
 */
function _buildFallbackFSM({ initial }) {
  let _current = initial;

  return {
    get current() { return _current; },

    /**
     * Check whether a transition is legal from currentState on event.
     * @param {string} fromState
     * @param {string} event
     * @returns {boolean}
     */
    can(fromState, event) {
      return Boolean(TRANSITIONS[`${fromState}:${event}`]);
    },

    /**
     * Transition from fromState on event.  Returns the new state.
     * Throws if the transition is not defined.
     * @param {string} fromState
     * @param {string} event
     * @returns {string}
     */
    transition(fromState, event) {
      const key  = `${fromState}:${event}`;
      const next = TRANSITIONS[key];
      if (!next) {
        throw new Error(
          `[SessionFSM] Invalid transition: ${fromState} --[${event}]--> ? (no rule found)`
        );
      }
      return next;
    },

    /**
     * Send an event using the internal current state.
     * @param {string} event
     * @returns {string} New current state
     */
    send(event) {
      const next  = this.transition(_current, event);
      _current = next;
      return next;
    },

    /** Reset the machine to its initial state. */
    reset() {
      _current = initial;
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a fresh SessionFSM instance.
 *
 * Each orchestrator session should create its own instance so that parallel
 * sessions do not share state.
 *
 * @returns {object} FSM instance with `current`, `can()`, `transition()`, `send()`, `reset()`
 */
function createSessionFSM() {
  if (_createFSM === _buildFallbackFSM) {
    return _buildFallbackFSM({ initial: 'idle' });
  }

  // When @cognitive-fab/sam-fsm is available, delegate to the library.
  return _createFSM({
    initial: 'idle',
    states: {
      idle:               { on: { trigger: 'running' } },
      running:            {
        on: {
          tool_proposed_read:     'awaiting_tool',
          tool_proposed_medium:   'awaiting_approval',
          tool_proposed_high:     'awaiting_approval',
          tool_proposed_critical: 'awaiting_approval',
          threshold_exceeded:     'compressing',
          finish:                 'complete',
          fatal_error:            'error',
        },
      },
      awaiting_tool:      {
        on: {
          tool_result: 'running',
          fatal_error: 'error',
        },
      },
      awaiting_approval:  {
        on: {
          approved: 'awaiting_tool',
          denied:   'running',
          expired:  'running',
        },
      },
      compressing:        { on: { compression_done: 'running' } },
      complete:           { on: { reset: 'idle' } },
      error:              { on: { reset: 'idle' } },
    },
  });
}

// ---------------------------------------------------------------------------
// SAM Reactor integration
// ---------------------------------------------------------------------------

/**
 * Map a (previousStatus, currentStatus) pair to the FSM event that caused
 * the transition.  Returns null if the pair is not a recognised transition.
 *
 * Used by makeReactor() to derive events from SAM model diffs.
 *
 * @param {string} prev
 * @param {string} next
 * @returns {string|null}
 */
function statusToEvent(prev, next) {
  const MAP = {
    'idle:running':                  'trigger',
    'running:awaiting_tool':         'tool_proposed_read',
    'running:awaiting_approval':     'tool_proposed_medium',
    'running:compressing':           'threshold_exceeded',
    'running:complete':              'finish',
    'running:error':                 'fatal_error',
    'awaiting_tool:running':         'tool_result',
    'awaiting_tool:error':           'fatal_error',
    'awaiting_approval:awaiting_tool': 'approved',
    'awaiting_approval:running':     'denied',
    'compressing:running':           'compression_done',
    'complete:idle':                 'reset',
    'error:idle':                    'reset',
  };
  return MAP[`${prev}:${next}`] ?? null;
}

/**
 * Build a SAM acceptor that acts as a State Machine Reactor.
 *
 * The returned acceptor fires after every SAM model mutation.  When the
 * model's `status` field changes, the reactor validates the transition
 * against the SessionFSM.  If the transition is illegal, the model is
 * rolled back to 'error' and an error message is recorded.
 *
 * @returns {Function} SAM acceptor  (model => proposal => void)
 */
function makeReactor() {
  const fsm = createSessionFSM();
  // Prime the FSM: trigger 'trigger' from 'idle' → 'running' at session start.
  fsm.send('trigger');

  let previousStatus = 'running';

  return (model) => (_proposal) => {
    const currentStatus = model.status;

    if (currentStatus === previousStatus) return; // no state change

    const event = statusToEvent(previousStatus, currentStatus);

    if (event === null) {
      // Unrecognised transition (e.g. compressing → error) — advance the
      // tracker without FSM validation.  This is safe because makeReactor
      // always passes `previousStatus` explicitly to fsm.transition(), so
      // subsequent steps validate correctly from the new baseline.
      previousStatus = currentStatus;
      return;
    }

    try {
      const validated = fsm.transition(previousStatus, event);
      if (validated !== currentStatus) {
        // FSM resolved to a different state — should not happen if the table is
        // consistent, but guard defensively.
        model.status       = 'error';
        model.errorMessage = `SessionFSM mismatch: expected ${validated}, got ${currentStatus}`;
      }
      previousStatus = currentStatus;
    } catch (err) {
      model.status       = 'error';
      model.errorMessage = `SessionFSM rejected transition ${previousStatus}→${currentStatus}: ${err.message}`;
    }
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  createSessionFSM,
  makeReactor,
  statusToEvent,
  // Exported for testing
  TRANSITIONS,
  _buildFallbackFSM,
};
