'use strict';

const nodemailer      = require('nodemailer');
const { ImapFlow }    = require('imapflow');
const { simpleParser } = require('mailparser');
const { getConfig }   = require('../config/cosa.config');
const { createLogger } = require('./logger');

// approval-engine also requires email-gateway, creating a circular dependency.
// Lazy-require it inside _dispatchMessage (after both modules are fully loaded)
// to avoid the partial-initialisation problem that makes processInboundReply
// appear as undefined.

/** Timestamp recorded at module load — used to skip emails that pre-date this boot. */
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
  if (APPROVAL_RE.test(text)) {
    await approvalEngine.processInboundReply(msg);
  } else if (_onNewSession) {
    await _onNewSession(msg);
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
  const { env } = getConfig();
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
    // `since` filters to messages received on or after the date (day boundary).
    // Combined with the in-process BOOT_TIME check below, this prevents a
    // backlog of old unseen messages from flooding COSA on startup.
    const seqs = await client.search({ seen: false, since: BOOT_TIME });

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

      // Layer 2 — DKIM check
      // Gmail injects Authentication-Results before IMAP delivery; a spoofed
      // message routed through any other server will fail or lack this header.
      const operatorDomain = operatorEmail.split('@')[1] ?? '';
      if (operatorDomain && !_dkimPasses(parsed, operatorDomain)) {
        log.warn(`Ignored message: DKIM check failed for <${fromAddr}> (possible spoofed email)`);
        continue;
      }

      const body = parsed.text?.trim() ?? '';
      const msg = {
        from:      fromAddr,
        subject:   fetched.envelope?.subject  ?? '',
        body,
        messageId: fetched.envelope?.messageId ?? null,
      };
      log.info(`Email received — subject: "${msg.subject}", body length: ${body.length}`);
      _dispatchMessage(msg).catch(err =>
        log.error(`Session dispatch error: ${err.message}`)
      );
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

module.exports = {
  sendEmail,
  startPolling,
  stopPolling,
  setNewSessionHandler,
  _runPoll,
};
