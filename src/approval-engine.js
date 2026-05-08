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
const emailGateway        = require('./email-gateway');
const { createLogger }    = require('./logger');

const log = createLogger('approval-engine');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How often the background expiry sweep runs. */
const EXPIRY_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Tracks the last time an approval email was dispatched, keyed by urgency bucket.
 * Resets on process restart — intentional, since overnight state is irrelevant
 * once the process is restarted in the morning.
 *
 * @type {{ urgent: Date|null, nonUrgent: Date|null }}
 */
const _lastApprovalEmailSent = { urgent: null, nonUrgent: null };

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
// Quiet-hours and rate-limit helpers
// ---------------------------------------------------------------------------

/**
 * Return the current hour (0–23) in the configured appliance timezone.
 *
 * Uses Intl.DateTimeFormat with hourCycle 'h23' (always 0–23, never "24")
 * in preference to toLocaleString hour12:false, which returns "24" for
 * midnight on some runtimes (Node/WSL) and therefore never triggers quiet
 * hours.  Falls back to the same Intl path with UTC rather than system
 * local time, so that a WSL process whose system clock is UTC still
 * evaluates quiet hours against the configured appliance timezone.
 *
 * @param {string} tz - IANA timezone string (e.g. "America/New_York")
 * @returns {number}
 */
function _localHour(tz) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' });
    return parseInt(fmt.format(new Date()), 10);
  } catch {
    // tz is invalid or Intl is unavailable — fall back to UTC so that a
    // UTC system clock does not silently bypass the quiet-hours gate.
    return new Date().getUTCHours();
  }
}

/**
 * Check whether sending an approval email is suppressed by quiet hours.
 *
 * Quiet hours apply to ALL emails (urgent and non-urgent): if the current
 * local hour is before `operator.quiet_hours_start`, returns true.
 * Set `quiet_hours_start: 0` (or omit) to disable.
 *
 * @param {object} operatorCfg - `appliance.operator` config block
 * @param {string} tz          - IANA timezone
 * @returns {boolean}
 */
function _isQuietHours(operatorCfg, tz) {
  const start = operatorCfg?.quiet_hours_start ?? 0;
  if (start === 0) return false;
  return _localHour(tz) < start;
}

/**
 * Check whether an approval email would exceed the per-urgency rate limit.
 *
 * @param {'once'|'urgent'} policy
 * @param {object} operatorCfg
 * @returns {{ limited: boolean, remainingMinutes: number }}
 */
function _isRateLimited(policy, operatorCfg) {
  const isUrgent       = policy === 'urgent';
  const intervalMin    = isUrgent
    ? (operatorCfg?.urgent_resend_interval_minutes    ?? 15)
    : (operatorCfg?.non_urgent_resend_interval_minutes ?? 60);
  const lastSent       = isUrgent ? _lastApprovalEmailSent.urgent : _lastApprovalEmailSent.nonUrgent;

  if (!lastSent) return { limited: false, remainingMinutes: 0 };

  const elapsedMs     = Date.now() - lastSent.getTime();
  const intervalMs    = intervalMin * 60 * 1000;
  if (elapsedMs >= intervalMs) return { limited: false, remainingMinutes: 0 };

  return {
    limited:          true,
    remainingMinutes: Math.ceil((intervalMs - elapsedMs) / 60_000),
  };
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

  // ── Quiet-hours gate ────────────────────────────────────────────────────────
  // Suppress ALL approval emails before operator.quiet_hours_start (local time).
  // The session will receive an auto-denied result; the cron task will retry on
  // its next scheduled run (e.g. the following night's backup window).
  const tz = appliance.appliance?.timezone ?? 'UTC';
  if (_isQuietHours(appliance.operator, tz)) {
    const start = appliance.operator?.quiet_hours_start ?? 0;
    log.info(
      `[approval-engine] quiet hours: suppressing ${policy} approval for ` +
      `${toolCall.tool_name} (before ${start}:00 ${tz})`
    );
    return { approved: false, note: `quiet hours — before ${start}:00 local time` };
  }

  // ── Rate-limit gate ─────────────────────────────────────────────────────────
  // Non-urgent (medium risk, cron): at most 1 email per non_urgent_resend_interval_minutes.
  // Urgent (high/critical): at most 1 email per urgent_resend_interval_minutes.
  const rl = _isRateLimited(policy, appliance.operator);
  if (rl.limited) {
    log.info(
      `[approval-engine] rate limit: suppressing ${policy} approval for ` +
      `${toolCall.tool_name} (next window in ${rl.remainingMinutes} min)`
    );
    return { approved: false, note: `rate limited — retry in ${rl.remainingMinutes} min` };
  }

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

  try {
    await emailGateway.sendEmail({
      to:      appliance.operator.email,
      subject: `[COSA] Approval Required: ${toolCall.tool_name}`,
      text:    buildRequestEmailText(token, toolCall, timeoutMinutes),
    });
    // Record send time for rate limiting.
    if (policy === 'urgent') {
      _lastApprovalEmailSent.urgent    = new Date();
    } else {
      _lastApprovalEmailSent.nonUrgent = new Date();
    }
  } catch (emailErr) {
    log.error(`Failed to send approval request email: ${emailErr.message}`);
    return { approved: false, note: 'Email delivery failed — cannot send approval request' };
  }

  return new Promise((resolve) => {
    const intents = _buildApprovalMachine(approvalId, (state, model) => {
      _pending.delete(approvalId);
      resolve({
        approved:   state === 'approved',
        note:       state === 'expired' ? 'expired' : (model.note ?? null),
        approvalId,
      });
    });

    // Store _resolve alongside the FSM intents so that processInboundReply and
    // _runExpiryCheck can force-resolve the Promise if the FSM intent throws —
    // preventing the requestApproval Promise from hanging forever.
    _pending.set(approvalId, { ...intents, _resolve: resolve });
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

  // Treat clock-expired-but-not-yet-swept rows as non-pending: a reply arriving
  // after the deadline is rejected even if the cron sweep hasn't fired yet.
  const nowExpired = approval && new Date(approval.expires_at) <= new Date();
  if (!approval || approval.status !== 'pending' || nowExpired) {
    // If the token exists in the DB but is no longer pending, let the operator
    // know their reply was received but could not be actioned.
    if (approval) {
      try {
        await emailGateway.sendEmail({
          to:      appliance.operator.email,
          subject: `[COSA] Approval Already ${approval.status}: ${approval.tool_name}`,
          text:    `Your reply regarding "${approval.tool_name}" was received, but this approval request has already ${approval.status}.`,
        });
      } catch (emailErr) {
        log.warn(`Failed to send expired-token feedback email: ${emailErr.message}`);
      }
    }
    return { action: 'ambiguous', approvalId: null };
  }

  const intents = _pending.get(approval.approval_id);
  if (!intents) {
    // The approval is pending in the DB but the session that created it is no
    // longer in memory (process restart, or session errored out before the
    // reply arrived).  Notify the operator so the reply does not vanish silently.
    try {
      await emailGateway.sendEmail({
        to:      appliance.operator.email,
        subject: `[COSA] Approval Reply Received but Session Gone: ${approval.tool_name}`,
        text: [
          `Your reply for "${approval.tool_name}" (token: ${token}) was received,`,
          `but the session that requested approval is no longer active.`,
          ``,
          `The action was NOT executed.`,
          ``,
          `This usually means COSA was restarted between when the approval email`,
          `was sent and when your reply arrived.  The next scheduled run will`,
          `create a new approval request if the condition still applies.`,
        ].join('\n'),
      });
    } catch (emailErr) {
      log.warn(`Failed to send orphaned-approval feedback email: ${emailErr.message}`);
    }
    return { action: 'ambiguous', approvalId: null };
  }

  const isDeny = /\bDENY\b/.test(upperText);

  if (isDeny) {
    // Preserve operator note from original (un-uppercased) text.
    const original  = `${msg.subject ?? ''} ${msg.body ?? ''}`.trim();
    const noteMatch = original.match(/DENY\s+APPROVE-[0-9A-F]{8}\s*(.*)/i);
    const note      = noteMatch && noteMatch[1].trim() ? noteMatch[1].trim() : null;

    // FSM first — ensures the transition is legal before committing to DB.
    // If the intent throws (e.g. already terminal), force-resolve so the
    // requestApproval Promise never hangs.
    try {
      await intents.deny({ note });
    } catch (err) {
      log.error(`FSM deny intent failed for approval ${approval.approval_id}: ${err.message}`);
      _pending.delete(approval.approval_id);
      intents._resolve({ approved: false, note: note ?? null, approvalId: approval.approval_id });
    }

    // DB after FSM — AND status='pending' guard makes this a no-op if already terminal.
    updateApprovalStatus(approval.approval_id, 'denied', msg.from, note);
    log.info(`Approval denied: ${approval.approval_id} (${approval.tool_name}) by ${msg.from}`);

    await emailGateway.sendEmail({
      to:      appliance.operator.email,
      subject: `[COSA] Denied: ${approval.tool_name}`,
      text:    `Your denial for "${approval.tool_name}" has been logged.${note ? `\n\nNote: ${note}` : ''}`,
    });

    return { action: 'denied', approvalId: approval.approval_id };
  }

  // ── Approve ───────────────────────────────────────────────────────────────

  // FSM first — same rationale as the deny path above.
  try {
    await intents.approve();
  } catch (err) {
    log.error(`FSM approve intent failed for approval ${approval.approval_id}: ${err.message}`);
    _pending.delete(approval.approval_id);
    intents._resolve({ approved: true, note: null, approvalId: approval.approval_id });
  }

  updateApprovalStatus(approval.approval_id, 'approved', msg.from, null);
  log.info(`Approval approved: ${approval.approval_id} (${approval.tool_name}) by ${msg.from}`);

  await emailGateway.sendEmail({
    to:      appliance.operator.email,
    subject: `[COSA] Approved: ${approval.tool_name}`,
    text:    `Your approval for "${approval.tool_name}" (token: ${token}) has been confirmed. The action will now execute.`,
  });

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

  // Collect emails so all DB writes finish first.  If the process crashes
  // mid-loop the DB is consistent (idempotent AND status='pending' guard);
  // the worst outcome is that some expiry notification emails are not sent.
  const emailsToSend = [];

  for (const approval of expired) {
    const entry = _pending.get(approval.approval_id);

    if (!entry) {
      // Orphaned approval — the session that created it is no longer running.
      // Mark expired in DB; skip operator notification (the request is dead).
      updateApprovalStatus(approval.approval_id, 'expired', 'system', null);
      continue;
    }

    // FSM first — ensures the transition is legal before committing to DB.
    try {
      await entry.expire();
    } catch (err) {
      log.error(`FSM expire intent failed for approval ${approval.approval_id}: ${err.message}`);
      _pending.delete(approval.approval_id);
      entry._resolve({ approved: false, note: 'expired', approvalId: approval.approval_id });
    }

    // DB after FSM — AND status='pending' guard makes this a no-op if already terminal.
    updateApprovalStatus(approval.approval_id, 'expired', 'system', null);
    log.info(`Approval expired: ${approval.approval_id} (${approval.tool_name})`);

    emailsToSend.push({
      to:      appliance.operator.email,
      subject: `[COSA] Expired: ${approval.tool_name}`,
      text:    `The approval request for "${approval.tool_name}" (token: ${approval.token}) has expired without a response.`,
    });
  }

  for (const mail of emailsToSend) {
    try {
      await emailGateway.sendEmail(mail);
    } catch (emailErr) {
      log.warn(`Failed to send expiry notification: ${emailErr.message}`);
    }
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
  // Reset rate-limit timestamps so tests start from a clean state.
  _lastApprovalEmailSent.urgent    = null;
  _lastApprovalEmailSent.nonUrgent = null;
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
