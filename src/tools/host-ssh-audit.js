'use strict';

/**
 * host-ssh-audit — audit COSA's OWN inbound SSH activity.
 *
 * Unlike every other tool, this one does NOT use the SSH backend (which targets
 * the BaanBaan appliance). It reads the *local* systemd journal on the host that
 * runs COSA, where sshd records every authentication event for connections INTO
 * this box.
 *
 * Threat model: exactly one host (the owner's laptop) ever has a legitimate
 * reason to SSH into COSA, using one account, with publickey auth. The normal
 * baseline therefore contains ZERO failed attempts and ZERO logins from any
 * other source. That makes deviation unusually high-signal:
 *
 *   • An accepted login from a non-trusted IP  → someone got in who shouldn't
 *     have (critical).
 *   • A login as an unexpected user            → wrong account, even from a
 *     trusted IP (critical).
 *   • ANY failed / invalid / pre-auth attempt  → a probe. On a box that never
 *     sees failures, a single one betrays malicious activity (high).
 */

const { execFile }     = require('child_process');
const { getConfig }    = require('../../config/cosa.config');
const { createLogger } = require('../logger');

const log = createLogger('host-ssh-audit');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME       = 'host_ssh_audit';
const RISK_LEVEL = 'read';

/** Default lookback window in minutes (24h). */
const DEFAULT_LOOKBACK_MINUTES = 1440;

/** Hard cap on journal lines read; filtered to the lookback window client-side. */
const DEFAULT_MAX_LINES = 5000;

/** Account(s) that may legitimately log in when config omits trusted_users. */
const DEFAULT_TRUSTED_USERS = ['cosa'];

/** systemd syslog identifiers sshd logs under (varies by OpenSSH version). */
const SSHD_IDENTIFIERS = ['sshd', 'sshd-session'];

const INPUT_SCHEMA = {
  type:                 'object',
  properties:           {},
  required:             [],
  additionalProperties: false,
};

const SCHEMA = {
  description:
    "Audit COSA's own inbound SSH activity by reading the local systemd journal " +
    '(sshd/sshd-session). Flags any accepted login from an IP not in trusted_ips ' +
    '(untrusted_accepted_login, critical), any login as a user not in trusted_users ' +
    '(unexpected_user_login, critical), and any failed/invalid/pre-auth attempt ' +
    '(failed_login_attempt, high) — on a host that should only ever see logins from ' +
    'one laptop, a single failure is signal. Returns an anomalies array (type, ' +
    'sourceIp, user, count, sample, severity, firstSeen, lastSeen), plus ' +
    'acceptedCount and failedCount. Always read-only.',
  inputSchema: INPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Line parsing
// ---------------------------------------------------------------------------

/**
 * Match the journalctl `-o short-iso` envelope and isolate the sshd message:
 *   2026-06-01T09:10:19-07:00 cosa sshd-session[73127]: <message>
 *
 * Only `sshd` / `sshd-session` identifiers are accepted; anything else returns
 * null so unrelated journal lines are ignored.
 *
 * @param {string} line
 * @returns {{ ts: Date, message: string } | null}
 */
function parseEnvelope(line) {
  const m = line.match(
    /^(\S+)\s+\S+\s+([\w-]+)\[\d+\]:\s+(.*)$/
  );
  if (!m) return null;

  const [, tsStr, ident, message] = m;
  if (!SSHD_IDENTIFIERS.includes(ident)) return null;

  const ts = new Date(tsStr);
  if (Number.isNaN(ts.getTime())) return null;

  return { ts, message };
}

/**
 * Classify a single sshd message into an auth event, or null if it is routine
 * noise (session open/close, normal user-initiated disconnect, etc.).
 *
 * `kind` is 'accepted' for a successful authentication and 'failed' for any
 * rejected / invalid / pre-auth-aborted attempt. `subtype` records the precise
 * shape for the human-readable sample.
 *
 * @param {string} message
 * @returns {{ kind:'accepted'|'failed', subtype:string, method:string|null,
 *             user:string|null, ip:string|null } | null}
 */
function classifyMessage(message) {
  let m;

  // ── Successful auth ───────────────────────────────────────────────────────
  // "Accepted publickey for cosa from 192.168.1.122 port 50495 ssh2: ED25519 …"
  m = message.match(/^Accepted (\w+) for (\S+) from (\S+) port \d+/);
  if (m) {
    return { kind: 'accepted', subtype: 'accepted', method: m[1], user: m[2], ip: m[3] };
  }

  // ── Failed password ───────────────────────────────────────────────────────
  // "Failed password for cosa from 1.2.3.4 port 55 ssh2"
  // "Failed password for invalid user admin from 1.2.3.4 port 55 ssh2"
  m = message.match(/^Failed (\w+) for (?:invalid user )?(\S+) from (\S+) port \d+/);
  if (m) {
    return { kind: 'failed', subtype: 'failed_password', method: m[1], user: m[2], ip: m[3] };
  }

  // ── Invalid user (no such account) ────────────────────────────────────────
  // "Invalid user admin from 1.2.3.4 port 55"
  m = message.match(/^Invalid user (\S+) from (\S+) port \d+/);
  if (m) {
    return { kind: 'failed', subtype: 'invalid_user', method: null, user: m[1], ip: m[2] };
  }

  // ── Pre-auth connection abort ─────────────────────────────────────────────
  // "Connection closed by 1.2.3.4 port 55 [preauth]"
  // "Connection closed by authenticating user root 1.2.3.4 port 55 [preauth]"
  // "Connection reset by 1.2.3.4 port 55 [preauth]"
  m = message.match(/^Connection (?:closed|reset) by (?:(?:authenticating|invalid) user (\S+) )?(\S+) port \d+ \[preauth\]/);
  if (m) {
    return { kind: 'failed', subtype: 'preauth_closed', method: null, user: m[1] ?? null, ip: m[2] };
  }

  // ── Pre-auth disconnect (only when authenticating/invalid — NOT a normal
  //    logout, which reads "Disconnected from user cosa …" without [preauth]).
  // "Disconnected from authenticating user root 1.2.3.4 port 55 [preauth]"
  m = message.match(/^Disconnected from (?:authenticating|invalid) user (\S+) (\S+) port \d+ \[preauth\]/);
  if (m) {
    return { kind: 'failed', subtype: 'preauth_disconnect', method: null, user: m[1], ip: m[2] };
  }

  // ── Too many attempts ─────────────────────────────────────────────────────
  // "error: maximum authentication attempts exceeded for root from 1.2.3.4 port 55 ssh2 [preauth]"
  m = message.match(/maximum authentication attempts exceeded for (?:invalid user )?(\S+) from (\S+) port \d+/);
  if (m) {
    return { kind: 'failed', subtype: 'max_attempts', method: null, user: m[1], ip: m[2] };
  }

  return null;
}

/**
 * Parse journalctl short-iso output into a chronological list of auth events.
 *
 * @param {string} stdout
 * @returns {Array<{ ts: Date, kind:'accepted'|'failed', subtype:string,
 *                    method:string|null, user:string|null, ip:string|null,
 *                    raw:string }>}
 */
function parseAuthEvents(stdout) {
  const events = [];
  for (const rawLine of String(stdout).split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const env = parseEnvelope(line);
    if (!env) continue;

    const evt = classifyMessage(env.message);
    if (!evt) continue;

    events.push({ ts: env.ts, raw: env.message, ...evt });
  }
  return events;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Apply the COSA inbound-SSH threat model to a list of parsed auth events.
 *
 * @param {Array<object>} events       - output of {@link parseAuthEvents}
 * @param {object}        opts
 * @param {string[]}      opts.trustedIps   - IPs allowed to log in successfully
 * @param {string[]}      opts.trustedUsers - accounts allowed to log in
 * @returns {Array<{ type:string, sourceIp:string, user:string|null, count:number,
 *                   sample:string, severity:string, firstSeen:string,
 *                   lastSeen:string }>}
 */
function detectAnomalies(events, { trustedIps, trustedUsers }) {
  const trustedIpSet   = new Set(trustedIps);
  const trustedUserSet = new Set(trustedUsers);
  const anomalies      = [];

  // ── 1. Accepted logins — one anomaly per offending login ───────────────────
  for (const e of events) {
    if (e.kind !== 'accepted') continue;

    const ipUntrusted   = !trustedIpSet.has(e.ip);
    const userUntrusted = !trustedUserSet.has(e.user);
    if (!ipUntrusted && !userUntrusted) continue;

    const iso = e.ts.toISOString();
    anomalies.push({
      type:      ipUntrusted ? 'untrusted_accepted_login' : 'unexpected_user_login',
      sourceIp:  e.ip,
      user:      e.user,
      count:     1,
      sample:    e.raw,
      severity:  'critical',
      firstSeen: iso,
      lastSeen:  iso,
    });
  }

  // ── 2. Failed / probe attempts — grouped per source IP ─────────────────────
  // On a host that never legitimately fails, every failed attempt is signal.
  const byIp = new Map();
  for (const e of events) {
    if (e.kind !== 'failed') continue;
    const key = e.ip ?? 'unknown';
    if (!byIp.has(key)) byIp.set(key, []);
    byIp.get(key).push(e);
  }

  for (const [ip, hits] of byIp) {
    hits.sort((a, b) => a.ts - b.ts);
    const users = [...new Set(hits.map(h => h.user).filter(Boolean))];
    anomalies.push({
      type:      'failed_login_attempt',
      sourceIp:  ip,
      user:      users.length ? users.join(',') : null,
      count:     hits.length,
      sample:    hits[0].raw,
      severity:  'high',
      firstSeen: hits[0].ts.toISOString(),
      lastSeen:  hits[hits.length - 1].ts.toISOString(),
    });
  }

  return anomalies;
}

// ---------------------------------------------------------------------------
// Local journal read
// ---------------------------------------------------------------------------

/**
 * Read recent sshd journal lines from the LOCAL host (the box running COSA),
 * newest-last, as `short-iso` text. Uses execFile with a fixed argument array —
 * no shell, no interpolation, so the static identifiers and numeric line cap
 * cannot be turned into an injection vector.
 *
 * @param {number} maxLines
 * @returns {Promise<string>} journalctl stdout
 */
function readSshJournal(maxLines) {
  const args = [];
  for (const id of SSHD_IDENTIFIERS) args.push('-t', id);
  args.push('-o', 'short-iso', '--no-pager', '-n', String(maxLines));

  return new Promise((resolve, reject) => {
    execFile(
      'journalctl',
      args,
      { maxBuffer: 16 * 1024 * 1024, timeout: 15000 },
      (err, stdout, stderr) => {
        if (err) {
          err.message = `journalctl read failed: ${err.message}` +
            (stderr ? ` (${String(stderr).trim()})` : '');
          return reject(err);
        }
        resolve(stdout || '');
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{
 *   summary: string,
 *   anomalies: Array<object>,
 *   acceptedCount: number,
 *   failedCount: number,
 *   lookbackMinutes: number,
 *   checked_at: string,
 * } | { skipped: true }>}
 */
async function handler() {
  const checked_at = new Date().toISOString();

  const cfg = getConfig().appliance.tools?.host_ssh_audit ?? {};
  if (cfg.enabled === false) return { skipped: true };

  const trustedIps   = cfg.trusted_ips   ?? [];
  const trustedUsers = cfg.trusted_users ?? DEFAULT_TRUSTED_USERS;
  const lookbackMin  = cfg.lookback_minutes ?? DEFAULT_LOOKBACK_MINUTES;
  const maxLines     = cfg.max_lines     ?? DEFAULT_MAX_LINES;

  if (trustedIps.length === 0) {
    // Without an allowlist EVERY accepted login looks untrusted, which would be
    // pure noise. Make the misconfiguration loud rather than silently alarming.
    log.warn(
      'host_ssh_audit.trusted_ips is empty — cannot distinguish legitimate ' +
      'logins. Set it to the owner laptop IP(s) in appliance.yaml.'
    );
  }

  // ── 1. Read the local sshd journal ────────────────────────────────────────
  log.info(`Reading local sshd journal (last ${maxLines} lines)`);
  const stdout = await readSshJournal(maxLines);

  // ── 2. Parse and filter to the lookback window ────────────────────────────
  const cutoff = new Date(Date.now() - lookbackMin * 60 * 1000);
  const events = parseAuthEvents(stdout).filter(e => e.ts >= cutoff);

  const acceptedCount = events.filter(e => e.kind === 'accepted').length;
  const failedCount   = events.filter(e => e.kind === 'failed').length;

  log.info(
    `Parsed ${events.length} auth events in lookback window ` +
    `(${acceptedCount} accepted, ${failedCount} failed)`
  );

  // ── 3. Detect anomalies ───────────────────────────────────────────────────
  const anomalies = detectAnomalies(events, { trustedIps, trustedUsers });

  const summary =
    anomalies.length === 0
      ? `No SSH anomalies: ${acceptedCount} accepted login(s) (all from trusted ` +
        `sources), 0 failed attempts over the past ${lookbackMin} minutes.`
      : `${anomalies.length} SSH anomaly(ies) detected over the past ${lookbackMin} ` +
        `minutes (${acceptedCount} accepted, ${failedCount} failed).`;

  log.info(summary);

  return {
    summary,
    anomalies,
    acceptedCount,
    failedCount,
    lookbackMinutes: lookbackMin,
    checked_at,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  name:      NAME,
  schema:    SCHEMA,
  handler,
  riskLevel: RISK_LEVEL,
  // Exported for unit testing:
  parseEnvelope,
  classifyMessage,
  parseAuthEvents,
  detectAnomalies,
  readSshJournal,
};
