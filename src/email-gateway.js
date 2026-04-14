'use strict';

const fs             = require('fs');
const os             = require('os');
const path           = require('path');
const nodemailer      = require('nodemailer');
const { ImapFlow }    = require('imapflow');
const { simpleParser } = require('mailparser');
const { getConfig }   = require('../config/cosa.config');
const { createLogger } = require('./logger');
const { saveDeadLetter } = require('./session-store');

// approval-engine also requires email-gateway, creating a circular dependency.
// Lazy-require it inside _dispatchMessage (after both modules are fully loaded)
// to avoid the partial-initialisation problem that makes processInboundReply
// appear as undefined.

// In production all requires happen synchronously during startup, so BOOT_TIME
// ≈ process start time.  If this module is loaded lazily (e.g. in a test) the
// timestamp reflects the require() call, not process start — that is fine
// because the IMAP polling loop hasn't started yet in either case.
const BOOT_TIME = new Date();

const log = createLogger('email-gateway');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Interval between IMAP poll cycles. */
const POLL_INTERVAL_MS = 60 * 1000;

/**
 * Pattern that identifies an approval-related reply.
 * Matches an 8-hex approval token or a bare DENY keyword.
 */
const APPROVAL_RE = /\bAPPROVE-[0-9A-F]{8}\b|\bDENY\b/i;

/**
 * Pattern that identifies a finding-suppression reply.
 * Format: SUPPRESS <fingerprint> [optional reason]
 * Example: SUPPRESS aws_access_key:test/backup.test.ts:270 test dummy key
 */
const SUPPRESS_RE = /\bSUPPRESS\s+\S+:\S+:\d+/i;

/**
 * Path where the daily outbound send count is persisted.
 * Survives process restarts within the same calendar day (UTC).
 */
const QUOTA_FILE = path.join(os.homedir(), '.cosa', 'email-quota.json');

// ---------------------------------------------------------------------------
// Daily send-quota helpers
// ---------------------------------------------------------------------------

/**
 * Load today's send count from disk.
 * Returns { date: 'YYYY-MM-DD', sent: N }.
 * If the file is absent, corrupt, or from a previous day, returns a fresh record.
 *
 * @returns {{ date: string, sent: number }}
 */
function _loadQuota() {
  try {
    const raw    = fs.readFileSync(QUOTA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const today  = new Date().toISOString().slice(0, 10);
    if (parsed.date === today && typeof parsed.sent === 'number') {
      return { date: today, sent: parsed.sent };
    }
  } catch { /* absent or corrupt — start fresh */ }
  return { date: new Date().toISOString().slice(0, 10), sent: 0 };
}

/**
 * Persist the current quota state to disk (best-effort; errors are logged).
 *
 * @param {{ date: string, sent: number }} quota
 */
function _saveQuota(quota) {
  try {
    fs.mkdirSync(path.dirname(QUOTA_FILE), { recursive: true });
    fs.writeFileSync(QUOTA_FILE, JSON.stringify(quota));
  } catch (err) {
    log.warn(`Failed to persist email quota: ${err.message}`);
  }
}

/**
 * Roll the quota to today if the stored date is stale.
 * Mutates `quota` in place.
 *
 * @param {{ date: string, sent: number }} quota
 */
function _rollIfNewDay(quota) {
  const today = new Date().toISOString().slice(0, 10);
  if (quota.date !== today) {
    quota.date = today;
    quota.sent = 0;
    _saveQuota(quota);
  }
}

/** In-memory daily send-quota state — loaded once at module init. */
const _quota = _loadQuota();

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** @type {ReturnType<typeof setInterval> | null} */
let _pollInterval = null;

/**
 * Cached nodemailer SMTP transport.
 * Lazily created on first send and reused for all subsequent outbound emails.
 * Using pool:true keeps the connection alive across sends, avoiding repeated
 * AUTH round-trips that trigger Google's "too many login attempts" rate limit.
 *
 * @type {import('nodemailer').Transporter | null}
 */
let _smtpTransport = null;

/**
 * Optional handler invoked for inbound messages that are not approval replies.
 * Wired to the orchestrator session factory by main.js at startup.
 *
 * @type {((msg: object) => Promise<void>) | null}
 */
let _onNewSession = null;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Return true if the parsed email's Authentication-Results header indicates
 * DKIM passed for the given domain.
 *
 * Gmail injects this header before delivering to IMAP:
 *   "Authentication-Results: mx.google.com; dkim=pass header.d=gmail.com ..."
 *
 * A spoofed email routed through a third-party server will either lack the
 * header or show dkim=fail/dkim=none. A legitimate Gmail send always passes.
 *
 * @param {import('mailparser').ParsedMail} parsed
 * @param {string} domain - operator's email domain, e.g. "gmail.com"
 * @returns {boolean}
 */
function _dkimPasses(parsed, domain) {
  const authHeader = (parsed.headers.get('authentication-results') ?? '').toLowerCase();
  return /dkim=pass/i.test(authHeader) && authHeader.includes(domain.toLowerCase());
}

/**
 * Build a new ImapFlow client using credentials from config.
 *
 * @returns {ImapFlow}
 */
function buildImapClient() {
  const { env } = getConfig();
  return new ImapFlow({
    host:   env.email.imapHost,
    port:   env.email.imapPort,
    secure: true,
    auth: {
      user: env.email.username,
      pass: env.email.appPassword,
    },
    logger: false,
  });
}

/**
 * Return the shared nodemailer SMTP transport, creating it on first call.
 * pool:true keeps the underlying TCP connection alive so subsequent sends
 * reuse the authenticated session instead of re-authenticating each time.
 *
 * @returns {import('nodemailer').Transporter}
 */
function getSmtpTransport() {
  if (_smtpTransport) return _smtpTransport;
  const { env } = getConfig();
  _smtpTransport = nodemailer.createTransport({
    host:   env.email.smtpHost,
    port:   env.email.smtpPort,
    secure: false, // STARTTLS on port 587
    pool:   true,  // reuse connection — avoid re-AUTH on every email
    auth: {
      user: env.email.username,
      pass: env.email.appPassword,
    },
  });
  return _smtpTransport;
}

/**
 * Route a validated inbound message to either the approval engine or the
 * new-session handler.
 *
 * @param {{ from: string, subject: string, body: string, messageId: string|null }} msg
 * @returns {Promise<void>}
 */
async function _dispatchMessage(msg) {
  // Lazy-require breaks the circular dependency with approval-engine.
  const approvalEngine = require('./approval-engine');
  const text = `${msg.subject} ${msg.body}`;

  if (SUPPRESS_RE.test(text)) {
    await _processSuppressReply(msg, text);
    return;
  }

  if (APPROVAL_RE.test(text)) {
    await approvalEngine.processInboundReply(msg);
  } else if (_onNewSession) {
    await _onNewSession(msg);
  }
}

/**
 * Parse and persist a SUPPRESS reply from the operator.
 *
 * Accepted format (case-insensitive):
 *   SUPPRESS <pattern>:<file>:<line> [optional reason text]
 *
 * @param {{ from: string }} msg
 * @param {string} text  - Combined subject + body (already assembled by caller)
 */
async function _processSuppressReply(msg, text) {
  const { createSuppression } = require('./session-store');
  const { getConfig }         = require('../config/cosa.config');
  const { appliance }         = getConfig();
  const operatorEmail         = appliance.operator?.email;

  const match = text.match(/\bSUPPRESS\s+(\S+:\S+:\d+)\s*(.*)/i);
  if (!match) return;

  const fingerprint = match[1].toLowerCase();
  const reason      = match[2].trim() || null;

  createSuppression({
    fingerprint,
    finding_type:   'credential',
    reason,
    suppressed_by:  msg.from,
  });

  log.info(`Finding suppressed by operator: ${fingerprint} — ${reason ?? '(no reason)'}`);

  if (operatorEmail) {
    try {
      await sendEmail({
        to:      operatorEmail,
        subject: `[COSA] Finding suppressed: ${fingerprint}`,
        text:    `The following finding has been suppressed and will no longer trigger alerts:\n\n  ${fingerprint}\n\nReason: ${reason ?? '(none provided)'}\nSuppressed by: ${msg.from}\n\nTo re-enable this finding, remove it from the suppressed_findings table in session.db or contact your COSA operator.`,
      });
    } catch (err) {
      log.warn(`Failed to send suppression confirmation email: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API — SMTP
// ---------------------------------------------------------------------------

/**
 * Send a plain-text email via SMTP.
 * No HTML is ever included; only the `text` field is used.
 *
 * @param {{
 *   to:          string,
 *   subject:     string,
 *   text:        string,
 *   inReplyTo?:  string,
 *   references?: string
 * }} options
 * @returns {Promise<void>}
 */
async function sendEmail({ to, subject, text, inReplyTo, references }) {
  const { env, appliance } = getConfig();

  // ── Daily send-quota gate ─────────────────────────────────────────────────
  // Hard cap to stay well within Gmail's 500/day limit.
  // Default: 50/day.  Override with operator.daily_send_limit in appliance.yaml.
  _rollIfNewDay(_quota);
  const dailyLimit = appliance.operator?.daily_send_limit ?? 50;

  if (_quota.sent >= dailyLimit) {
    log.error(
      `[email-gateway] Daily send limit (${dailyLimit}) reached — ` +
      `dropping: "${subject}" → ${to}`
    );
    // Dead-letter so the email is not silently lost; it can be inspected later.
    try {
      saveDeadLetter({ subject, to, body: text }, 'daily_send_limit_exceeded');
    } catch { /* best-effort */ }
    return; // Do NOT throw — let the calling session continue gracefully.
  }

  if (_quota.sent >= Math.floor(dailyLimit * 0.8)) {
    log.warn(
      `[email-gateway] Daily send quota at ${_quota.sent + 1}/${dailyLimit} — ` +
      `approaching limit`
    );
  }

  // ── Send ───────────────────────────────────────────────────────────────────
  const transport = getSmtpTransport();

  /** @type {import('nodemailer').SendMailOptions} */
  const mailOptions = {
    from:    env.email.address,
    to,
    subject,
    text,
  };

  if (inReplyTo)  mailOptions.inReplyTo  = inReplyTo;
  if (references) mailOptions.references = references;

  await transport.sendMail(mailOptions);

  _quota.sent++;
  _saveQuota(_quota);
  log.info(`[email-gateway] Sent ${_quota.sent}/${dailyLimit} today: "${subject}"`);
}

// ---------------------------------------------------------------------------
// Public API — IMAP polling
// ---------------------------------------------------------------------------

/**
 * Perform a single IMAP poll cycle:
 *   1. Connect to INBOX
 *   2. Fetch all unseen messages
 *   3. Ignore non-operator senders (log warning)
 *   4. Dispatch operator messages to the approval engine or new-session handler
 *   5. Mark every fetched message as \\Seen
 *
 * @returns {Promise<void>}
 */
async function _runPoll() {
  const { env, appliance } = getConfig();
  const operatorEmail = appliance.operator.email.toLowerCase();
  const client = buildImapClient();

  await client.connect();

  let lock;
  try {
    lock = await client.getMailboxLock('INBOX');
    // Use a 2-day lookback window rather than BOOT_TIME to avoid a date-boundary
    // race: ImapFlow's `since` is day-granular and can miss messages that arrived
    // near midnight depending on timezone offsets between the Pi and Gmail's IMAP
    // server.  The per-message BOOT_TIME guard below handles stale messages.
    const since2d = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const seqs = await client.search({ seen: false, since: since2d });

    for (const seq of seqs) {
      const fetched = await client.fetchOne(String(seq), {
        envelope:     true,
        source:       true,
        internalDate: true,
      });

      // Skip emails that arrived before this process started — they are stale
      // messages from a previous COSA session that were not yet marked seen.
      if (fetched.internalDate && fetched.internalDate < BOOT_TIME) {
        await client.messageFlagsAdd(String(seq), ['\\Seen']);
        log.info(`Skipped pre-boot email (arrived ${fetched.internalDate.toISOString()})`);
        continue;
      }

      // Mark seen immediately — before dispatching — so that long-running
      // sessions (e.g. waiting for operator approval) don't cause the next
      // poll cycle to pick up the same message and spawn a duplicate session.
      await client.messageFlagsAdd(String(seq), ['\\Seen']);

      // Parse full source to access both headers (DKIM) and body text.
      const parsed  = await simpleParser(fetched.source ?? Buffer.alloc(0));
      const fromAddr = (
        parsed.from?.value?.[0]?.address ??
        fetched.envelope?.from?.[0]?.address ?? ''
      ).toLowerCase();

      // Layer 1 — From-address allowlist (trivially spoofable but fast first gate)
      if (fromAddr !== operatorEmail) {
        log.warn(`Ignored message from non-operator: <${fromAddr}>`);
        continue;
      }

      // Layer 2 — DKIM check (Gmail only by default).
      // Gmail injects Authentication-Results before IMAP delivery; a spoofed
      // message routed through any other server will fail or lack this header.
      // Non-Gmail providers don't inject this header, so the check is opt-out
      // via appliance.security.dkim_check: false in appliance.yaml.
      const dkimCheckEnabled = appliance.security?.dkim_check !== false;
      const operatorDomain   = operatorEmail.split('@')[1] ?? '';
      if (dkimCheckEnabled && operatorDomain && !_dkimPasses(parsed, operatorDomain)) {
        log.warn(`Ignored message: DKIM check failed for <${fromAddr}> (possible spoofed email)`);
        continue;
      }

      // Extract readable content from text/JSON attachments and append it to
      // the body so COSA can see file contents without requiring orchestrator
      // changes.  Binary attachments (images, PDFs, etc.) are ignored.
      // Cap each attachment at 128 KB to guard against oversized payloads.
      const MAX_ATTACHMENT_BYTES = 128 * 1024;
      const attachmentTexts = (parsed.attachments ?? [])
        .filter(a => {
          const ct = (a.contentType ?? '').toLowerCase();
          return ct.startsWith('text/') || ct === 'application/json';
        })
        .map(a => {
          const label   = a.filename ? `[Attachment: ${a.filename}]` : '[Attachment]';
          const raw     = a.content ?? Buffer.alloc(0);
          const content = raw.slice(0, MAX_ATTACHMENT_BYTES).toString('utf8').trim();
          const truncNote = raw.length > MAX_ATTACHMENT_BYTES
            ? `\n[truncated — original size ${raw.length} bytes]`
            : '';
          return `${label}\n${content}${truncNote}`;
        });

      const body = [parsed.text?.trim() ?? '', ...attachmentTexts]
        .filter(Boolean)
        .join('\n\n');

      const msg = {
        from:      fromAddr,
        subject:   fetched.envelope?.subject  ?? '',
        body,
        messageId: fetched.envelope?.messageId ?? null,
      };
      log.info(
        `Email received — subject: "${msg.subject}", body length: ${body.length}` +
        (attachmentTexts.length ? `, attachments: ${attachmentTexts.length}` : '')
      );
      _dispatchMessage(msg).catch(err => {
        log.error(`Session dispatch error: ${err.message}`);
        try {
          saveDeadLetter(msg, err.message);
        } catch (dlErr) {
          log.error(`Dead-letter write failed: ${dlErr.message}`);
        }
      });
    }
  } finally {
    if (lock) lock.release();
    await client.logout().catch(() => {});
  }
}

/**
 * Start the background IMAP polling loop.
 * A second call while polling is already active is a silent no-op.
 *
 * @param {number} [intervalMs] - Interval override for testing.
 */
function startPolling(intervalMs = POLL_INTERVAL_MS) {
  if (_pollInterval !== null) return;
  _pollInterval = setInterval(() => {
    _runPoll().catch(err =>
      log.error(`Poll cycle error: ${err.message}`)
    );
  }, intervalMs);
}

/**
 * Stop the background IMAP polling loop.
 */
function stopPolling() {
  if (_pollInterval !== null) {
    clearInterval(_pollInterval);
    _pollInterval = null;
  }
}

/**
 * Register the handler called when a non-approval inbound message arrives.
 * Typically wired to the orchestrator session factory in main.js.
 *
 * @param {(msg: object) => Promise<void>} fn
 */
function setNewSessionHandler(fn) {
  _onNewSession = fn;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Reset the cached SMTP transport.
 * **For use in tests only** — allows each test to verify `createTransport`
 * is called with the correct config without interference from prior tests.
 */
function _resetSmtpTransport() {
  _smtpTransport = null;
}

module.exports = {
  sendEmail,
  startPolling,
  stopPolling,
  setNewSessionHandler,
  _runPoll,
  _resetSmtpTransport,
};
