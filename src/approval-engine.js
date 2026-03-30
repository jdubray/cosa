'use strict';

const crypto = require('crypto');
const { createInstance, api } = require('@cognitive-fab/sam-pattern');
const { fsm }                 = require('@cognitive-fab/sam-fsm');
const { getConfig }           = require('../config/cosa.config');
const {
  createApproval,
  findApprovalByToken,
  updateApprovalStatus,
  findExpiredApprovals,
} = require('./session-store');
const emailGateway = require('./email-gateway');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How often the background expiry sweep runs. */
const EXPIRY_CHECK_INTERVAL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Approval FSM definition
// ---------------------------------------------------------------------------

/**
 * Transitions for the per-approval state machine.
 * Terminal states (approved, denied, expired) have no outbound edges.
 */
const APPROVAL_TRANSITIONS = [
  { from: 'pending', to: 'approved', on: 'approve' },
  { from: 'pending', to: 'denied',   on: 'deny'    },
  { from: 'pending', to: 'expired',  on: 'expire'  },
];

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/**
 * In-memory map from approvalId → action intents { approve, deny, expire }.
 * Populated by requestApproval(); consumed by processInboundReply() and
 * _runExpiryCheck().
 *
 * @type {Map<string, { approve: Function, deny: Function, expire: Function }>}
 */
const _pending = new Map();

/** @type {ReturnType<typeof setInterval> | null} */
let _expiryInterval = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically secure approval token.
 *
 * @returns {string} `APPROVE-XXXXXXXX` where X is an uppercase hex digit.
 */
function generateToken() {
  return `APPROVE-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

/**
 * Build the plain-text body for an approval request email.
 *
 * @param {string} token
 * @param {{ tool_name: string, action_summary?: string, input?: object, riskLevel: string }} toolCall
 * @param {number} timeoutMinutes
 * @returns {string}
 */
function buildRequestEmailText(token, toolCall, timeoutMinutes) {
  const summary = toolCall.action_summary ?? JSON.stringify(toolCall.input);
  return [
    'COSA requires your approval before executing the following action:',
    '',
    `Tool:    ${toolCall.tool_name}`,
    `Summary: ${summary}`,
    `Risk:    ${toolCall.riskLevel}`,
    '',
    'To APPROVE, reply with:',
    `  ${token}`,
    '',
    'To DENY, reply with:',
    `  DENY ${token} [optional reason]`,
    '',
    `This request expires in ${timeoutMinutes} minutes.`,
  ].join('\n');
}

/**
 * Build a per-approval SAM FSM instance and return the three action intents.
 *
 * The `onTerminal` callback fires exactly once when the FSM reaches
 * `approved`, `denied`, or `expired`.
 *
 * @param {string} approvalId
 * @param {(state: 'approved'|'denied'|'expired', model: object) => void} onTerminal
 * @returns {{ approve: Function, deny: Function, expire: Function }}
 */
function _buildApprovalMachine(approvalId, onTerminal) {
  // Derive pc0 and the `actions` map required by sam-fsm so that
  // machine.addAction() can validate action names.
  const { pc0, actions: fsmActions } = fsm.actionsAndStatesFor(APPROVAL_TRANSITIONS);

  const machine = fsm({
    pc0,
    actions:                  fsmActions,
    transitions:              APPROVAL_TRANSITIONS,
    deterministic:            true,
    enforceAllowedTransitions: true,
  });

  const samInst = createInstance({ instanceName: `approval-${approvalId}` });
  const samApi  = api(samInst);

  // Seed the model with FSM initial state.
  samApi.addInitialState(machine.initialState({}));

  // FSM acceptors handle pc transitions; the extra acceptor captures denial note.
  samApi.addAcceptors([
    ...machine.acceptors,
    model => proposal => {
      if (proposal.__actionName === 'deny') {
        model.note = proposal.note ?? null;
      }
    },
  ]);

  // State-machine reactor derives allowed actions from the current pc.
  samApi.addReactors(machine.stateMachine);

  // Wrap raw action functions with the FSM guard.
  const wrappedApprove = machine.addAction(async ()              => ({}),                  'approve');
  const wrappedDeny    = machine.addAction(async ({ note } = {}) => ({ note: note ?? null }), 'deny');
  const wrappedExpire  = machine.addAction(async ()              => ({}),                  'expire');

  const { intents: [approve, deny, expire] } = samApi.getIntents([
    wrappedApprove,
    wrappedDeny,
    wrappedExpire,
  ]);

  // Render fires after every model cycle; resolve the outer Promise on terminal states.
  samApi.setRender(model => {
    const pc = model.pc;
    if (pc === 'approved' || pc === 'denied' || pc === 'expired') {
      onTerminal(pc, model);
    }
  });

  return { approve, deny, expire };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Determine whether a tool call requires manual operator approval.
 *
 * Policy:
 *   - 'read'   → always auto (no approval needed)
 *   - 'medium' → auto when the session was triggered by an operator email
 *                (the email itself constitutes explicit operator consent);
 *                'once' for cron/cli-triggered sessions
 *   - 'high' / 'critical' → always 'once' regardless of trigger
 *
 * @param {{ riskLevel: string, triggerType?: string }} toolCall
 * @returns {'auto' | 'once'}
 */
function requiresApproval(toolCall) {
  if (toolCall.riskLevel === 'read') return 'auto';
  if (toolCall.riskLevel === 'medium' && toolCall.triggerType === 'email') return 'auto';
  return 'once';
}

/**
 * Create an approval record, email the operator, and return a Promise that
 * resolves when the operator approves or denies (or the request expires).
 *
 * Internally builds a per-approval SAM FSM instance and stores the resulting
 * action intents in `_pending` so that processInboundReply() and
 * _runExpiryCheck() can drive the machine forward.
 *
 * @param {string} sessionId
 * @param {{ tool_name: string, input: object, riskLevel: string, action_summary?: string }} toolCall
 * @param {'once' | 'urgent'} [policy='once']
 * @returns {Promise<{ approved: boolean, note: string | null }>}
 */
async function requestApproval(sessionId, toolCall, policy = 'once') {
  const { appliance } = getConfig();

  // NODE_ENV=staging shortens the window to 2 minutes for fast integration tests.
  const timeoutMinutes = process.env.NODE_ENV === 'staging'
    ? 2
    : policy === 'urgent'
      ? (appliance.operator?.urgent_approval_timeout_minutes ?? 5)
      : (appliance.operator?.approval_timeout_minutes ?? 30);

  const token      = generateToken();
  const approvalId = crypto.randomUUID();
  const expiresAt  = new Date(Date.now() + timeoutMinutes * 60 * 1000).toISOString();

  createApproval({
    approval_id:    approvalId,
    session_id:     sessionId,
    token,
    tool_name:      toolCall.tool_name,
    action_summary: toolCall.action_summary ?? JSON.stringify(toolCall.input),
    risk_level:     toolCall.riskLevel,
    scope:          'once',
    expires_at:     expiresAt,
  });

  await emailGateway.sendEmail({
    to:      appliance.operator.email,
    subject: `[COSA] Approval Required: ${toolCall.tool_name}`,
    text:    buildRequestEmailText(token, toolCall, timeoutMinutes),
  });

  return new Promise((resolve) => {
    const intents = _buildApprovalMachine(approvalId, (state, model) => {
      _pending.delete(approvalId);
      resolve({
        approved: state === 'approved',
        note:     state === 'expired' ? 'expired' : (model.note ?? null),
      });
    });

    _pending.set(approvalId, intents);
  });
}

/**
 * Process an inbound email reply from the operator and drive the FSM.
 *
 * Recognised patterns (case-insensitive):
 * - `APPROVE-XXXXXXXX`             → approve the matching pending request
 * - `DENY APPROVE-XXXXXXXX [note]` → deny the matching pending request
 * - anything else                  → ambiguous (no state change)
 *
 * @param {{ subject?: string, body?: string, from: string }} msg
 * @returns {Promise<{ action: 'approved' | 'denied' | 'ambiguous', approvalId: string | null }>}
 */
async function processInboundReply(msg) {
  const { appliance } = getConfig();

  // Uppercase the full text so the regex works regardless of operator casing.
  const upperText = `${msg.subject ?? ''} ${msg.body ?? ''}`.trim().toUpperCase();

  const tokenMatch = upperText.match(/\bAPPROVE-[0-9A-F]{8}\b/);
  if (!tokenMatch) {
    return { action: 'ambiguous', approvalId: null };
  }

  const token    = tokenMatch[0]; // already uppercased
  const approval = findApprovalByToken(token);

  if (!approval || approval.status !== 'pending') {
    return { action: 'ambiguous', approvalId: null };
  }

  const intents = _pending.get(approval.approval_id);
  if (!intents) {
    return { action: 'ambiguous', approvalId: null };
  }

  const isDeny = /\bDENY\b/.test(upperText);

  if (isDeny) {
    // Preserve operator note from original (un-uppercased) text.
    const original  = `${msg.subject ?? ''} ${msg.body ?? ''}`.trim();
    const noteMatch = original.match(/DENY\s+APPROVE-[0-9A-F]{8}\s*(.*)/i);
    const note      = noteMatch && noteMatch[1].trim() ? noteMatch[1].trim() : null;

    updateApprovalStatus(approval.approval_id, 'denied', msg.from, note);

    await emailGateway.sendEmail({
      to:      appliance.operator.email,
      subject: `[COSA] Denied: ${approval.tool_name}`,
      text:    `Your denial for "${approval.tool_name}" has been logged.${note ? `\n\nNote: ${note}` : ''}`,
    });

    // Drive the FSM — this will trigger onTerminal → resolve the outer Promise.
    await intents.deny({ note });

    return { action: 'denied', approvalId: approval.approval_id };
  }

  // ── Approve ───────────────────────────────────────────────────────────────
  updateApprovalStatus(approval.approval_id, 'approved', msg.from, null);

  await emailGateway.sendEmail({
    to:      appliance.operator.email,
    subject: `[COSA] Approved: ${approval.tool_name}`,
    text:    `Your approval for "${approval.tool_name}" (token: ${token}) has been confirmed. The action will now execute.`,
  });

  await intents.approve();

  return { action: 'approved', approvalId: approval.approval_id };
}

/**
 * Expire all pending approvals whose deadline has passed.
 * Called automatically by the background interval; also exported for direct
 * testing.
 *
 * @returns {Promise<void>}
 */
async function _runExpiryCheck() {
  const { appliance } = getConfig();
  const expired = findExpiredApprovals();

  for (const approval of expired) {
    updateApprovalStatus(approval.approval_id, 'expired', 'system', null);

    const intents = _pending.get(approval.approval_id);
    if (!intents) {
      // Orphaned approval — the session that created it is no longer running
      // (e.g. process was restarted).  Mark it expired in the DB but skip the
      // operator notification: the request is already dead, so emailing is noise.
      continue;
    }

    await emailGateway.sendEmail({
      to:      appliance.operator.email,
      subject: `[COSA] Expired: ${approval.tool_name}`,
      text:    `The approval request for "${approval.tool_name}" (token: ${approval.token}) has expired without a response.`,
    });

    await intents.expire();
  }
}

/**
 * Start the background expiry sweep.
 * Calling this when the sweep is already running is a no-op.
 *
 * @param {number} [intervalMs] - Override interval for testing.
 */
function startExpiryCheck(intervalMs = EXPIRY_CHECK_INTERVAL_MS) {
  if (_expiryInterval !== null) return;
  _expiryInterval = setInterval(_runExpiryCheck, intervalMs);
}

/**
 * Stop the background expiry sweep.
 */
function stopExpiryCheck() {
  if (_expiryInterval !== null) {
    clearInterval(_expiryInterval);
    _expiryInterval = null;
  }
}

/**
 * Discard all in-memory pending intents.
 * **For use in tests only.**
 */
function _clearPending() {
  _pending.clear();
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  requiresApproval,
  requestApproval,
  processInboundReply,
  startExpiryCheck,
  stopExpiryCheck,
  _runExpiryCheck,
  _clearPending,
};
