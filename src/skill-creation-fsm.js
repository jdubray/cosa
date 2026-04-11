'use strict';

/**
 * SkillCreationFSM — Skill Creation Lifecycle State Machine
 *
 * Implements the 6-state skill creation workflow defined in §19.2 of the
 * Phase 2 specification using @cognitive-fab/sam-fsm.
 *
 * States:
 *   idle        → No skill creation in progress
 *   evaluating  → Post-session hook checking whether a novel incident occurred
 *   searching   → FTS5 search of skills.db for a matching existing skill
 *   generating  → Calling claude-haiku-4-5 to generate a new skill document
 *   validating  → Checking generated skill structure; validating required sections
 *   persisted   → Skill inserted into skills.db; operator notified
 *
 * Integration: Action Binding pattern.
 * Each FSM state transition is driven by calling the corresponding
 * sam-pattern action.  The sam-fsm machine acts as the acceptor that
 * validates the transition before the model is mutated.
 */

let _createFSM;
try {
  const fn = require('@cognitive-fab/sam-fsm').createFSM;
  // Guard: the package may exist but not export createFSM (wrong version, etc.)
  _createFSM = typeof fn === 'function' ? fn : _buildFallbackFSM;
} catch {
  _createFSM = _buildFallbackFSM;
}

// ---------------------------------------------------------------------------
// FSM transition table
// ---------------------------------------------------------------------------

const TRANSITIONS = {
  // ── From idle ──────────────────────────────────────────────────────────────
  'idle:post_session_hook':    'evaluating',

  // ── From evaluating ────────────────────────────────────────────────────────
  'evaluating:novel_detected': 'searching',
  'evaluating:not_novel':      'idle',

  // ── From searching ─────────────────────────────────────────────────────────
  'searching:no_match':        'generating',
  'searching:match_found':     'idle',       // existing skill: flag for improvement only

  // ── From generating ────────────────────────────────────────────────────────
  'generating:generated':      'validating',

  // ── From validating ────────────────────────────────────────────────────────
  'validating:valid':          'persisted',
  'validating:invalid':        'generating', // retry; max 2 attempts enforced externally
  'validating:retry_exceeded': 'idle',       // log failure; no skill saved

  // ── From persisted ─────────────────────────────────────────────────────────
  'persisted:reset':           'idle',
};

// ---------------------------------------------------------------------------
// Fallback FSM builder
// ---------------------------------------------------------------------------

function _buildFallbackFSM({ initial }) {
  let _current = initial;

  return {
    get current() { return _current; },

    can(fromState, event) {
      return Boolean(TRANSITIONS[`${fromState}:${event}`]);
    },

    transition(fromState, event) {
      const key  = `${fromState}:${event}`;
      const next = TRANSITIONS[key];
      if (!next) {
        throw new Error(
          `[SkillCreationFSM] Invalid transition: ${fromState} --[${event}]--> ? (no rule found)`
        );
      }
      return next;
    },

    send(event) {
      const next = this.transition(_current, event);
      _current   = next;
      return next;
    },

    reset() {
      _current = initial;
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a fresh SkillCreationFSM instance.
 * One instance is used per post-session skill creation attempt.
 *
 * @returns {object} FSM instance with `current`, `can()`, `transition()`, `send()`, `reset()`
 */
function createSkillCreationFSM() {
  if (_createFSM === _buildFallbackFSM) {
    return _buildFallbackFSM({ initial: 'idle' });
  }

  return _createFSM({
    initial: 'idle',
    states: {
      idle:       {
        on: { post_session_hook: 'evaluating' },
      },
      evaluating: {
        on: {
          novel_detected: 'searching',
          not_novel:      'idle',
        },
      },
      searching:  {
        on: {
          no_match:    'generating',
          match_found: 'idle',
        },
      },
      generating: {
        on: { generated: 'validating' },
      },
      validating: {
        on: {
          valid:          'persisted',
          invalid:        'generating',
          retry_exceeded: 'idle',
        },
      },
      persisted:  {
        on: { reset: 'idle' },
      },
    },
  });
}

/**
 * Map (fromState, toState) to the FSM event string.
 *
 * @param {string} from
 * @param {string} to
 * @returns {string|null}
 */
function _stateToEvent(from, to) {
  const MAP = {
    'idle:evaluating':       'post_session_hook',
    'evaluating:searching':  'novel_detected',
    'evaluating:idle':       'not_novel',
    'searching:generating':  'no_match',
    'searching:idle':        'match_found',
    'generating:validating': 'generated',
    'validating:persisted':  'valid',
    'validating:generating': 'invalid',
    'validating:idle':       'retry_exceeded',
    'persisted:idle':        'reset',
  };
  return MAP[`${from}:${to}`] ?? null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  createSkillCreationFSM,
  TRANSITIONS,
  _buildFallbackFSM,
  _stateToEvent,
};
