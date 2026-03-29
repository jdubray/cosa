'use strict';

const nodemailer      = require('nodemailer');
const { ImapFlow }    = require('imapflow');
const { getConfig }   = require('../config/cosa.config');
const approvalEngine  = require('./approval-engine');
const { createLogger } = require('./logger');

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
 * Build a nodemailer SMTP transport using credentials from config.
 *
 * @returns {import('nodemailer').Transporter}
 */
function buildSmtpTransport() {
  const { env } = getConfig();
  return nodemailer.createTransport({
    host:   env.email.smtpHost,
    port:   env.email.smtpPort,
    secure: false, // STARTTLS on port 587
    auth: {
      user: env.email.username,
      pass: env.email.appPassword,
    },
  });
}

/**
 * Route a validated inbound message to either the approval engine or the
 * new-session handler.
 *
 * @param {{ from: string, subject: string, body: string, messageId: string|null }} msg
 * @returns {Promise<void>}
 */
async function _dispatchMessage(msg) {
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
  const transport = buildSmtpTransport();

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
    const seqs = await client.search({ seen: false });

    for (const seq of seqs) {
      const fetched = await client.fetchOne(String(seq), {
        envelope:  true,
        bodyParts: ['TEXT'],
      });

      const fromAddr = (fetched.envelope?.from?.[0]?.address ?? '').toLowerCase();

      if (fromAddr !== operatorEmail) {
        log.warn(`Ignored message from non-operator: <${fromAddr}>`);
      } else {
        const body = fetched.bodyParts?.get('TEXT')?.toString() ?? '';
        const msg = {
          from:      fromAddr,
          subject:   fetched.envelope?.subject  ?? '',
          body,
          messageId: fetched.envelope?.messageId ?? null,
        };
        await _dispatchMessage(msg);
      }

      await client.messageFlagsAdd(String(seq), ['\\Seen']);
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
