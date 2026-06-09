'use strict';

// ---------------------------------------------------------------------------
// Home-IP allowlist updater
//
// Lets the operator update their *home* entry in BaanBaan's ALLOWED_MERCHANT_IPS
// by emailing COSA — the home equivalent of what internet_ip_watch already does
// automatically for the restaurant's own public IP.
//
// The email channel's authentication (operator From-address + DKIM) is enforced
// upstream in email-gateway._runPoll, so by the time handleHomeIpEmail runs the
// sender is already trusted. This module only parses, validates, and applies.
//
// Only the home entries are touched: the restaurant's auto-managed entry (and any
// other entries) in ALLOWED_MERCHANT_IPS are preserved. The previously-applied
// home IPs are remembered in home-ip-state.json so the next update replaces the
// right ones instead of accumulating stale addresses.
// ---------------------------------------------------------------------------

const fs   = require('fs');
const net  = require('net');
const path = require('path');

const sshBackend       = require('./ssh-backend');
const { getConfig }    = require('../config/cosa.config');
const { shEscape }     = require('./shell-utils');
const { createLogger } = require('./logger');

const log = createLogger('home-ip-allowlist');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default .env key holding the merchant IP allowlist (comma-separated list). */
const DEFAULT_ALLOWLIST_KEY = 'ALLOWED_MERCHANT_IPS';

/**
 * Command keyword that marks an inbound email as a home-IP update request.
 * Matched against `${subject} ${body}` by email-gateway, mirroring how the
 * APPROVE-/SUPPRESS commands are detected. Accepts the natural phrasings the
 * operator actually writes: "HOME-IP", "HOMEIP", and "home IP" (any spaces or
 * hyphens between the two words). Punctuation between them (e.g. "home. IP")
 * does NOT match, which keeps incidental prose from hijacking the handler.
 */
const HOME_IP_RE = /\bHOME[-\s]*IP\b/i;

/** Valid .env key: letter/underscore then alphanumerics/underscore (mirrors cron-scheduler). */
const SAFE_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Allowed characters in a systemd service name (mirrors cron-scheduler / restart-appliance). */
const SAFE_SERVICE_NAME = /^[a-zA-Z0-9_\-.@]+$/;

// ---------------------------------------------------------------------------
// Parsing & validation
// ---------------------------------------------------------------------------

/**
 * Strip characters that commonly bracket an address in prose (e.g. `[2607::1]`,
 * trailing punctuation) so the bare token can be validated by net.isIP.
 * Keeps only the hex/digit/dot/colon characters that can appear in an IP.
 *
 * @param {string} token
 * @returns {string}
 */
function _stripToken(token) {
  return token.replace(/^[^0-9A-Fa-f]+/, '').replace(/[^0-9A-Fa-f:.]+$/, '');
}

/**
 * Reduce an IPv6 address (host address or a `…/NN` CIDR) to its canonical
 * /64 prefix, e.g. `2607:fb90:b280:7739:127:2d21:c79:94ea` →
 * `2607:fb90:b280:7739::/64`.
 *
 * IPv6 hosts on a SLAAC LAN pick rotating addresses within their delegated /64,
 * so the stable unit to allowlist is the /64 prefix — which is also the form the
 * existing ALLOWED_MERCHANT_IPS entries use. A single /128 host address would
 * not reliably match and would churn on every reconnect.
 *
 * @param {string} input - An IPv6 address, optionally with a `/NN` suffix.
 * @returns {string|null} `"<prefix>::/64"`, or null if not a valid IPv6.
 */
function ipv6Prefix64(input) {
  const addr = String(input).split('/')[0].split('%')[0].trim();
  if (net.isIP(addr) !== 6) return null;

  let head, tail;
  if (addr.includes('::')) {
    const [h, t] = addr.split('::');
    head = h ? h.split(':') : [];
    tail = t ? t.split(':') : [];
  } else {
    head = addr.split(':');
    tail = [];
  }
  const missing = 8 - (head.length + tail.length);
  if (missing < 0) return null;
  const groups = [...head, ...Array(missing).fill('0'), ...tail];

  // Canonicalise the first four hextets (strip leading zeros, lowercase).
  const prefix = groups.slice(0, 4).map(g => parseInt(g || '0', 16).toString(16));
  return `${prefix.join(':')}::/64`;
}

/**
 * Extract the home IPv4 and IPv6 from free-form email text.
 *
 * Tokenises on whitespace/commas; a trailing CIDR suffix (`…/64`) is stripped
 * before validation so both host addresses and explicit prefixes are accepted.
 * IPv4 is taken as the host address; IPv6 is normalised to its /64 prefix (see
 * ipv6Prefix64). The first valid address of each family wins.
 *
 * @param {string} text - Combined subject + body of the inbound email.
 * @returns {{ v4: string|null, v6: string|null }}
 */
function parseHomeIps(text) {
  const result = { v4: null, v6: null };
  if (typeof text !== 'string') return result;

  for (const rawToken of text.split(/[\s,]+/)) {
    const [addrPart] = rawToken.split('/');          // drop any CIDR suffix
    const token = _stripToken(addrPart);
    if (!token) continue;
    const kind = net.isIP(token);
    if (kind === 4 && result.v4 === null) {
      result.v4 = token;
    } else if (kind === 6 && result.v6 === null) {
      result.v6 = ipv6Prefix64(token);               // always store the /64 prefix
    }
  }
  return result;
}

/**
 * Compute the new ALLOWED_MERCHANT_IPS value.
 *
 * Behaviour:
 *  - Every entry that is NOT a home entry (restaurant auto-IP, etc.) is preserved
 *    in its original position.
 *  - For each address family present in `newHome`, the previous home address of
 *    that family is removed and the new one appended. Families absent from
 *    `newHome` leave the prior home entry untouched.
 *  - The result is de-duplicated, preserving first-seen order.
 *
 * Pure function — no I/O. The exhaustive unit under test.
 *
 * @param {string} currentValue - Raw comma-separated value from the .env line.
 * @param {{ v4: string|null, v6: string|null }} prevHome - Last applied home IPs.
 * @param {{ v4: string|null, v6: string|null }} newHome  - Incoming home IPs.
 * @returns {string} The new comma-separated value.
 */
function computeAllowlist(currentValue, prevHome, newHome) {
  const parts = (currentValue ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  // Addresses to drop: the prior home entry of each family we're updating, plus
  // the incoming values themselves (so we re-append rather than duplicate).
  const drop = new Set();
  if (newHome.v4) { if (prevHome?.v4) drop.add(prevHome.v4); drop.add(newHome.v4); }
  if (newHome.v6) { if (prevHome?.v6) drop.add(prevHome.v6); drop.add(newHome.v6); }

  const kept = parts.filter(p => !drop.has(p));
  if (newHome.v4) kept.push(newHome.v4);
  if (newHome.v6) kept.push(newHome.v6);

  // De-dupe, preserving order.
  const seen = new Set();
  const out  = [];
  for (const p of kept) {
    if (!seen.has(p)) { seen.add(p); out.push(p); }
  }
  return out.join(',');
}

// ---------------------------------------------------------------------------
// Persistent home-IP state
// ---------------------------------------------------------------------------

/**
 * @typedef {{ v4: string|null, v6: string|null, lastUpdatedAt: string|null }} HomeIpState
 */

/** @returns {string} Absolute path to the home-IP state file. */
function _stateFilePath() {
  const { env } = getConfig();
  return path.resolve(env.dataDir, 'home-ip-state.json');
}

/**
 * Read persisted home-IP state. Returns nulls when absent or unreadable.
 * @returns {HomeIpState}
 */
function readHomeIpState() {
  try {
    const raw = fs.readFileSync(_stateFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      v4: parsed.v4 ?? null,
      v6: parsed.v6 ?? null,
      lastUpdatedAt: parsed.lastUpdatedAt ?? null,
    };
  } catch {
    return { v4: null, v6: null, lastUpdatedAt: null };
  }
}

/**
 * Persist home-IP state to disk (creates the data dir if needed).
 * @param {HomeIpState} state
 */
function writeHomeIpState(state) {
  const filePath = _stateFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// SSH application
// ---------------------------------------------------------------------------

/**
 * Resolve the effective config for the home-IP updater, defaulting to the
 * internet_ip_watch settings so the .env path and services stay single-sourced.
 *
 * @returns {{ enabled: boolean, envFilePath: string|null, allowlistKey: string, serviceNames: string[], restartOnChange: boolean }}
 */
function _resolveConfig() {
  const { appliance } = getConfig();
  const watchCfg = appliance.tools?.internet_ip_watch ?? {};
  const homeCfg  = appliance.tools?.home_ip_update ?? {};
  return {
    enabled:         homeCfg.enabled !== false,
    envFilePath:     homeCfg.env_file_path ?? watchCfg.env_file_path ?? null,
    allowlistKey:    homeCfg.allowlist_key ?? DEFAULT_ALLOWLIST_KEY,
    serviceNames:    homeCfg.service_names ?? watchCfg.service_names ?? ['baanbaan'],
    restartOnChange: homeCfg.restart_service_on_change !== false,
  };
}

/**
 * Apply the home-IP update to the appliance's .env over SSH and restart services.
 *
 * @param {{ v4: string|null, v6: string|null }} newHome - Already-validated IPs.
 * @returns {Promise<{
 *   success: boolean,
 *   oldList: string|null,
 *   newList: string|null,
 *   restarted: string[],
 *   errors: string[],
 *   error?: string,
 * }>}
 */
async function applyHomeIpUpdate(newHome) {
  const cfg    = _resolveConfig();
  const errors = [];

  if (!cfg.enabled) {
    return { success: false, oldList: null, newList: null, restarted: [], errors: [], error: 'home_ip_update is disabled' };
  }
  if (!cfg.envFilePath) {
    return { success: false, oldList: null, newList: null, restarted: [], errors: [], error: 'No env_file_path configured (home_ip_update / internet_ip_watch)' };
  }
  if (!SAFE_ENV_KEY.test(cfg.allowlistKey)) {
    return { success: false, oldList: null, newList: null, restarted: [], errors: [], error: `Unsafe allowlist key rejected: ${cfg.allowlistKey}` };
  }
  if (!newHome.v4 && !newHome.v6) {
    return { success: false, oldList: null, newList: null, restarted: [], errors: [], error: 'No valid home IP (v4 or v6) provided' };
  }
  if (!sshBackend.isConnected()) {
    return { success: false, oldList: null, newList: null, restarted: [], errors: [], error: 'SSH not connected — appliance .env not updated' };
  }

  const key      = cfg.allowlistKey;
  const safePath = shEscape(cfg.envFilePath);

  // ── 1. Confirm the key exists (safe no-op otherwise — never create it) ──────
  const existsResult = await sshBackend.exec(`grep -q '^${key}=' '${safePath}'`);
  if (existsResult.exitCode !== 0) {
    return { success: false, oldList: null, newList: null, restarted: [], errors: [], error: `Key ${key} not found in ${cfg.envFilePath}` };
  }

  // ── 2. Read the current value ──────────────────────────────────────────────
  const readResult = await sshBackend.exec(`grep '^${key}=' '${safePath}'`);
  if (readResult.exitCode !== 0) {
    return { success: false, oldList: null, newList: null, restarted: [], errors: [], error: `Failed to read ${key} from ${cfg.envFilePath}` };
  }
  const currentLine  = readResult.stdout.trim();
  const eqIdx        = currentLine.indexOf('=');
  const currentValue = eqIdx >= 0 ? currentLine.slice(eqIdx + 1) : '';

  // ── 3. Compute the new value ───────────────────────────────────────────────
  const prevHome = readHomeIpState();
  const newValue = computeAllowlist(currentValue, prevHome, newHome);

  if (newValue === currentValue) {
    // Nothing actually changed — record state (in case it drifted) and return.
    writeHomeIpState({
      v4: newHome.v4 ?? prevHome.v4,
      v6: newHome.v6 ?? prevHome.v6,
      lastUpdatedAt: new Date().toISOString(),
    });
    return { success: true, oldList: currentValue, newList: newValue, restarted: [], errors: [] };
  }

  // ── 4. Write it back ───────────────────────────────────────────────────────
  // IPs are validated by net.isIP (digits/hex/dots/colons only), so they cannot
  // carry shell metacharacters; escape sed-special chars defensively anyway.
  const escapedValue = newValue.replace(/[|\\&]/g, '\\$&');
  const sedCmd       = `sed -i 's|^${key}=.*|${key}=${escapedValue}|' '${safePath}'`;
  const sedResult    = await sshBackend.exec(sedCmd);
  if (sedResult.exitCode !== 0) {
    return {
      success: false, oldList: currentValue, newList: null, restarted: [], errors: [],
      error: `sed failed (exit ${sedResult.exitCode}): ${sedResult.stderr.trim()}`,
    };
  }

  // ── 5. Persist new home state ──────────────────────────────────────────────
  writeHomeIpState({
    v4: newHome.v4 ?? prevHome.v4,
    v6: newHome.v6 ?? prevHome.v6,
    lastUpdatedAt: new Date().toISOString(),
  });

  // ── 6. Restart services so the change takes effect ─────────────────────────
  const restarted = [];
  if (cfg.restartOnChange) {
    for (const name of cfg.serviceNames) {
      if (!SAFE_SERVICE_NAME.test(name)) {
        errors.push(`Skipped unsafe service name: ${name}`);
        log.error(`[home-ip] Rejected service name with shell metacharacters: ${name}`);
        continue;
      }
      try {
        const r = await sshBackend.exec(`sudo systemctl restart ${name}`);
        if (r.exitCode === 0) {
          restarted.push(name);
          log.info(`[home-ip] Service ${name} restarted`);
        } else {
          errors.push(`systemctl restart ${name} failed (exit ${r.exitCode})`);
          log.error(`[home-ip] Service ${name} restart failed: ${r.stderr.trim()}`);
        }
      } catch (err) {
        errors.push(`Service restart ${name}: ${err.message}`);
        log.error(`[home-ip] Service ${name} restart threw: ${err.message}`);
      }
    }
  }

  return { success: true, oldList: currentValue, newList: newValue, restarted, errors };
}

// ---------------------------------------------------------------------------
// Email entry point
// ---------------------------------------------------------------------------

/**
 * Handle a HOME-IP update email end to end: parse, validate, apply, and reply.
 *
 * The caller (email-gateway) has already verified the sender. This function
 * always replies to the operator with the outcome.
 *
 * @param {{ from: string, subject: string, body: string, messageId: string|null }} msg
 * @returns {Promise<void>}
 */
async function handleHomeIpEmail(msg) {
  // Lazy require breaks the email-gateway ⇄ home-ip-allowlist circular dependency
  // (same pattern email-gateway uses for approval-engine).
  const emailGateway = require('./email-gateway');
  const { appliance } = getConfig();
  const operatorEmail = appliance.operator?.email;

  const text = `${msg.subject ?? ''} ${msg.body ?? ''}`;
  const newHome = parseHomeIps(text);

  if (!newHome.v4 && !newHome.v6) {
    log.warn(`[home-ip] No valid IP found in HOME-IP email from ${msg.from}`);
    if (operatorEmail) {
      await emailGateway.sendEmail({
        to:      operatorEmail,
        subject: '[COSA] Home IP update — no valid address found',
        text:
          'COSA received a HOME-IP request but could not find a valid IP address in it.\n\n' +
          'Send the keyword HOME-IP followed by your IPv4 and/or IPv6 address, e.g.:\n\n' +
          '  HOME-IP 172.56.108.188 2607:fb90:b280:7739:9484:6ed3:28d7:dcb0\n\n' +
          'You can send just one family or both.',
      }).catch(err => log.warn(`[home-ip] reply failed: ${err.message}`));
    }
    return;
  }

  let result;
  try {
    result = await applyHomeIpUpdate(newHome);
  } catch (err) {
    log.error(`[home-ip] update threw: ${err.message}`);
    result = { success: false, oldList: null, newList: null, restarted: [], errors: [], error: err.message };
  }

  const reqLines = [
    `Requested home IP update:`,
    `  IPv4: ${newHome.v4 ?? '(unchanged)'}`,
    `  IPv6: ${newHome.v6 ?? '(unchanged)'}`,
    '',
  ];

  if (!result.success) {
    log.warn(`[home-ip] update failed: ${result.error}`);
    if (operatorEmail) {
      await emailGateway.sendEmail({
        to:      operatorEmail,
        subject: '[COSA] Home IP update FAILED',
        text:    [...reqLines, `The allowlist was NOT changed.`, `Reason: ${result.error}`].join('\n'),
        inReplyTo:  msg.messageId ?? undefined,
        references: msg.messageId ?? undefined,
      }).catch(err => log.warn(`[home-ip] reply failed: ${err.message}`));
    }
    return;
  }

  log.info(`[home-ip] ALLOWED_MERCHANT_IPS updated: "${result.oldList}" → "${result.newList}"`);
  if (operatorEmail) {
    const lines = [
      ...reqLines,
      `ALLOWED_MERCHANT_IPS updated:`,
      `  before: ${result.oldList}`,
      `  after:  ${result.newList}`,
      '',
      result.restarted.length
        ? `Services restarted: ${result.restarted.join(', ')}`
        : `Services restarted: none`,
    ];
    if (result.errors.length) {
      lines.push('', 'Warnings:', ...result.errors.map(e => `  - ${e}`));
    }
    lines.push('', '--- Automated update from COSA ---');
    await emailGateway.sendEmail({
      to:      operatorEmail,
      subject: '[COSA] Home IP updated',
      text:    lines.join('\n'),
      inReplyTo:  msg.messageId ?? undefined,
      references: msg.messageId ?? undefined,
    }).catch(err => log.warn(`[home-ip] reply failed: ${err.message}`));
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  HOME_IP_RE,
  parseHomeIps,
  ipv6Prefix64,
  computeAllowlist,
  readHomeIpState,
  writeHomeIpState,
  applyHomeIpUpdate,
  handleHomeIpEmail,
};
