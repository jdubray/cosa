'use strict';

/**
 * Single-quote-escape a value so it is safe to embed inside a single-quoted
 * bash argument. The only character that can break a single-quote context is
 * `'` itself, which is replaced by `'\''` (end quote, escaped single-quote,
 * reopen quote).
 *
 * Replaces four duplicate inline implementations: cron-scheduler.js (named
 * `shellSingleQuote`), backup-run.js, backup-verify.js, unit-health.js, and
 * webhook-hmac-verify.js (all named `shEscape`). 2026-05-18 review §C QW#1.
 *
 * @param {unknown} value - coerced to string before escaping
 * @returns {string}
 */
function shEscape(value) {
  return String(value).replace(/'/g, "'\\''");
}

/**
 * Whitelist for systemd/pm2 service names used in `systemctl`/`pm2` commands.
 * Allows only alphanumerics, `_ - . @` — `@` is required for systemd template
 * units (e.g. `getty@tty1.service`). Blocks every shell metacharacter, so a
 * validated name is safe to interpolate into a command string.
 *
 * Single source of truth — previously duplicated (with drift) in
 * restart-appliance.js, pause-appliance.js, and cron-scheduler.js.
 *
 * @type {RegExp}
 */
const SAFE_SERVICE_NAME = /^[a-zA-Z0-9_\-.@]+$/;

module.exports = { shEscape, SAFE_SERVICE_NAME };
