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
 * Matches an APPROVE token (8–64 hex chars — tolerant of the token-length change
 * from 32-bit to 128-bit so in-flight tokens still route) or a bare DENY keyword.
 */
const APPROVAL_RE = /\bAPPROVE-[0-9A-F]{8,64}\b|\bDENY\b/i;

/**
 * Maximum unseen messages processed in a single poll cycle. Bounds resource and
 * Claude-budget exposure to an inbox flood; the remainder are handled next poll.
 */
const MAX_MESSAGES_PER_POLL = 25;

/**
 * Pattern that identifies a finding-suppression reply.
 * Format: SUPPRESS <fingerprint> [optional reason]
 * Example: SUPPRESS aws_access_key:test/backup.test.ts:270 test dummy key
 */
const SUPPRESS_RE = /\bSUPPRESS\s+\S+:\S+:\d+/i;

/**
 * Pattern that identifies a home-IP allowlist update reply.
 * Matches "HOME-IP", "HOMEIP", or "home IP" (any spaces/hyphens between the
 * words); the address(es) are parsed by home-ip-allowlist. Kept in sync with
 * home-ip-allowlist.HOME_IP_RE.
 */
const HOME_IP_RE = /\bHOME[-\s]*IP\b/i;

/**
 * Loose match for an IP-change request that did NOT use the HOME-IP keyword.
 *
 * Requires a change/update verb within ~30 characters of the word "IP", in
 * either order, so both "IP Address change" and "my new IP is …" match while
 * incidental mentions of an IP do not. Callers must ALSO confirm the text
 * carries a parseable address (see _dispatchMessage) before acting on it.
 *
 * Without this branch such a message falls through to the generic orchestrator,
 * which has no knowledge of the home-IP tool and has told the operator the
 * change was impossible (observed 2026-08-01). Mirrors SUPPRESS_LOOSE_RE.
 */
const HOME_IP_LOOSE_RE = new RegExp(
  '\\b(?:change|changed|changing|update|updated|updating|new|renew|refresh|rotate|switch)\\b[^\\n]{0,30}?\\bIP\\b' +
  '|\\bIP\\b(?:\\s+address)?[^\\n]{0,30}?\\b(?:change|changed|changing|update|updated|updating|new|renew|refresh|rotate|switch)\\b',
  'i'
);

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

/** Escape a string for safe interpolation into a RegExp. */
function _escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Return true if the parsed email's Authentication-Results header indicates
 * DKIM passed *and is domain-aligned* with the operator's domain.
 *
 * Gmail injects this header before delivering to IMAP:
 *   "Authentication-Results: mx.google.com; dkim=pass header.d=gmail.com ..."
 *
 * Security: only the FIRST Authentication-Results header is trusted — that is
 * the one prepended by the receiving MTA (Gmail) reflecting its own verification.
 * Any Authentication-Results lines below it were present in the message as it
 * arrived and may have been forged by the sender, so they are ignored. We also
 * require that the dkim=pass result is aligned to the operator's domain via
 * header.d / header.i rather than merely appearing somewhere in the string — a
 * naive substring match is trivially defeated by a crafted header.
 *
 * @param {import('mailparser').ParsedMail} parsed
 * @param {string} domain - operator's email domain, e.g. "gmail.com"
 * @returns {boolean}
 */
function _dkimPasses(parsed, domain) {
  const dom = String(domain).toLowerCase();
  if (!dom) return false;

  const authLines = (parsed.headerLines ?? [])
    .filter(h => h.key === 'authentication-results')
    .map(h => String(h.line).toLowerCase());
  if (authLines.length === 0) return false;

  // Trust only the topmost (MTA-added) header.
  const trusted = authLines[0];
  if (!/dkim\s*=\s*pass/.test(trusted)) return false;

  const d = _escapeRe(dom);
  const aligned =
    new RegExp(`header\\.d\\s*=\\s*${d}\\b`).test(trusted) ||
    new RegExp(`header\\.i\\s*=\\s*@?[^;\\s]*${d}\\b`).test(trusted);
  return aligned;
}

/**
 * Build a new ImapFlow client using credentials from config.
 *
 * @returns {ImapFlow}
 */
function buildImapClient() {
  const { env } = getConfig();
  const client = new ImapFlow({
    host:             env.email.imapHost,
    port:             env.email.imapPort,
    secure:           true,
    connectionTimeout: 30_000,
    greetingTimeout:   15_000,
    socketTimeout:     30_000,
    auth: {
      user: env.email.username,
      pass: env.email.appPassword,
    },
    logger: false,
  });
  // ImapFlow emits 'error' on socket timeouts independently of the awaited
  // promise rejection. Without a listener, Node treats it as unhandled and
  // crashes the process (observed 2026-05-17 09:40 PDT).
  client.on('error', (err) => {
    log.warn(`IMAP client error event: ${err.message}`);
  });
  return client;
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
    host:              env.email.smtpHost,
    port:              env.email.smtpPort,
    secure:            false,  // STARTTLS on port 587
    requireTLS:        true,   // abort if server does not offer STARTTLS
    tls:               { rejectUnauthorized: true },
    pool:              true,   // reuse connection — avoid re-AUTH on every email
    connectionTimeout: 30_000,
    greetingTimeout:   15_000,
    socketTimeout:     30_000,
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

  // Operator typed SUPPRESS but the format didn't match. Without this branch
  // the reply would be treated as a brand-new orchestrator session, and the
  // operator would get no feedback that their suppression failed to parse
  // (2026-05-18 review §B P2 #15). Reply with the expected format.
  if (SUPPRESS_LOOSE_RE.test(text)) {
    log.warn(`Received SUPPRESS reply with unrecognised format from ${msg.from}`);
    await _sendSuppressionFormatError(msg);
    return;
  }

  // Home-IP allowlist update — operator emails their new home IP so COSA can
  // refresh the home entry in ALLOWED_MERCHANT_IPS (the home-side equivalent of
  // internet_ip_watch). Sender is already verified (From + DKIM) by _runPoll.
  if (HOME_IP_RE.test(text)) {
    const { handleHomeIpEmail } = require('./home-ip-allowlist');
    await handleHomeIpEmail(msg);
    return;
  }

  // Checked BEFORE the loose home-IP branch: an approval reply about an
  // IP-related action would otherwise be swallowed by the hint below.
  if (APPROVAL_RE.test(text)) {
    await approvalEngine.processInboundReply(msg);
    return;
  }

  // Operator clearly asked to change an IP and supplied one, but did not use
  // the HOME-IP keyword. Reply with the expected syntax rather than handing the
  // request to the generic orchestrator, which cannot perform the update.
  if (HOME_IP_LOOSE_RE.test(text)) {
    const { parseHomeIps } = require('./home-ip-allowlist');
    const parsed = parseHomeIps(text);
    if (parsed.v4 || parsed.v6) {
      log.warn(`Received IP-change request without the HOME-IP keyword from ${msg.from}`);
      await _sendHomeIpFormatHint(parsed);
      return;
    }
  }

  if (_onNewSession) {
    await _onNewSession(msg);
  }
}

/**
 * Send the operator the exact HOME-IP line that would apply the addresses they
 * already sent, so the retry is a copy-paste rather than a re-derivation.
 *
 * @param {{ v4: string|null, v6: string|null }} parsed - Addresses found in the email.
 */
async function _sendHomeIpFormatHint(parsed) {
  const { appliance } = getConfig();
  const operatorEmail = appliance.operator?.email;
  if (!operatorEmail) return;

  const suggested = ['HOME-IP', parsed.v4, parsed.v6].filter(Boolean).join(' ');

  try {
    await sendEmail({
      to:      operatorEmail,
      subject: '[COSA] Home IP update — keyword missing',
      text:
        'COSA can update the home entry in ALLOWED_MERCHANT_IPS for you, but the ' +
        'request must start with the HOME-IP keyword. No change was made.\n\n' +
        'Reply with:\n\n' +
        `  ${suggested}\n\n` +
        'That is the keyword followed by the address(es) found in your message. ' +
        'You can send just one address family or both.\n\n' +
        'If you meant something else, resend your message without an IP address in it.',
    });
  } catch (err) {
    log.warn(`Failed to send home-IP format hint email: ${err.message}`);
  }
}

/** Loose match — anything starting with "SUPPRESS " (catches malformed attempts). */
const SUPPRESS_LOOSE_RE = /\bSUPPRESS\b/i;

/**
 * Send a polite parser-error reply when the operator typed SUPPRESS with the
 * wrong format. Includes the expected syntax so the next attempt can succeed.
 *
 * @param {{ from: string }} msg
 */
async function _sendSuppressionFormatError(msg) {
  const { appliance } = getConfig();
  const operatorEmail = appliance.operator?.email;
  if (!operatorEmail) return;
  try {
    await sendEmail({
      to:      operatorEmail,
      subject: '[COSA] Suppression request could not be parsed',
      text:
        'COSA could not parse your suppression request.\n\n' +
        'Expected format:\n' +
        '  SUPPRESS <pattern>:<file>:<line> [optional reason]\n\n' +
        'Example:\n' +
        '  SUPPRESS aws_access_key:test/backup.test.ts:270 test fixture\n\n' +
        'Reply with the corrected format and the suppression will be recorded.',
    });
  } catch (err) {
    log.warn(`Failed to send suppression format-error email: ${err.message}`);
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

  // ── Recipient allowlist ───────────────────────────────────────────────────
  // All outbound emails must go to the configured operator address.
  // This prevents accidental or injected sends to unintended recipients.
  const operatorEmail = appliance.operator?.email;
  if (operatorEmail && to.toLowerCase() !== operatorEmail.toLowerCase()) {
    log.warn(`[email-gateway] Blocked outbound email to non-operator address <${to}> — dropping: "${subject}"`);
    return;
  }

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

  try {
    await transport.sendMail(mailOptions);
  } catch (err) {
    // Reset the cached transport so the next call recreates a fresh connection
    // rather than retrying on a potentially broken pooled socket.
    _smtpTransport = null;
    throw err;
  }

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
    let seqs = await client.search({ seen: false, since: since2d });

    // Bound work per poll cycle. Each non-approval message can spawn a full
    // orchestrator session (Claude calls + tool runs), so an inbox flood — e.g.
    // spoofed-From messages before the DKIM gate rejects them — could exhaust
    // resources and Claude budget. Process at most MAX_MESSAGES_PER_POLL now; the
    // remainder stay unseen and are picked up on the next poll.
    if (Array.isArray(seqs) && seqs.length > MAX_MESSAGES_PER_POLL) {
      log.warn(`Inbox has ${seqs.length} unseen messages; processing first ${MAX_MESSAGES_PER_POLL} this cycle (rate limit)`);
      seqs = seqs.slice(0, MAX_MESSAGES_PER_POLL);
    }

    for (const seq of seqs) {
      try {
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
      } catch (msgErr) {
        // A single malformed or unparseable message must not abort the rest of
        // the batch.  Log, attempt to mark seen so we don't retry next poll, and
        // move on to the next message.
        log.warn(`Failed to process message seq ${seq}: ${msgErr.message}`);
        try {
          await client.messageFlagsAdd(String(seq), ['\\Seen']);
        } catch { /* best-effort */ }
      }
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
