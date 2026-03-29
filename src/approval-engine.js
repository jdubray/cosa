'use strict';

const crypto = require('crypto');
const { getConfig } = require('../config/cosa.config');
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
// Module-level state
// ---------------------------------------------------------------------------

/**
 * In-memory map from approvalId → pending resolve callback.
 * Populated by requestApproval(); consumed by processInboundReply() and
 * _runExpiryCheck().
 *
 * @type {Map<string, { resolve: Function }>}
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Determine whether a tool call requires manual operator approval.
 *
 * @param {{ riskLevel: string }} toolCall
 * @returns {'auto' | 'once'}
 *   `'auto'` means the tool may execute immediately;
 *   `'once'` means operator approval is required before execution.
 */
function requiresApproval(toolCall) {
  return toolCall.riskLevel === 'read' ? 'auto' : 'once';
}

/**
 * Create an approval record, email the operator, and return a Promise that
 * resolves when the operator approves or denies (or expires).
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
    _pending.set(approvalId, { resolve });
  });
}

/**
 * Process an inbound email reply from the operator and transition the FSM.
 *
 * Recognised patterns (case-insensitive):
 * - `APPROVE-XXXXXXXX`           → approve the matching pending request
 * - `DENY APPROVE-XXXXXXXX [note]` → deny the matching pending request
 * - anything else                 → ambiguous (no state change)
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

    const cb = _pending.get(approval.approval_id);
    if (cb) {
      _pending.delete(approval.approval_id);
      cb.resolve({ approved: false, note });
    }

    return { action: 'denied', approvalId: approval.approval_id };
  }

  // ── Approve ───────────────────────────────────────────────────────────────
  updateApprovalStatus(approval.approval_id, 'approved', msg.from, null);

  await emailGateway.sendEmail({
    to:      appliance.operator.email,
    subject: `[COSA] Approved: ${approval.tool_name}`,
    text:    `Your approval for "${approval.tool_name}" (token: ${token}) has been confirmed. The action will now execute.`,
  });

  const cb = _pending.get(approval.approval_id);
  if (cb) {
    _pending.delete(approval.approval_id);
    cb.resolve({ approved: true, note: null });
  }

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

    await emailGateway.sendEmail({
      to:      appliance.operator.email,
      subject: `[COSA] Expired: ${approval.tool_name}`,
      text:    `The approval request for "${approval.tool_name}" (token: ${approval.token}) has expired without a response.`,
    });

    const cb = _pending.get(approval.approval_id);
    if (cb) {
      _pending.delete(approval.approval_id);
      cb.resolve({ approved: false, note: 'expired' });
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
 * Discard all in-memory pending callbacks.
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
