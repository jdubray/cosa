'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Numeric rank for each log level — lower means less verbose. */
const LEVELS = Object.freeze({
  debug: 0,
  info:  1,
  warn:  2,
  error: 3,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the numeric threshold for the currently configured log level.
 *
 * Reads `COSA_LOG_LEVEL` from the process environment on every call so that
 * tests can change the level without re-requiring the module.
 *
 * @returns {number}
 */
function effectiveLevel() {
  const raw = (process.env.COSA_LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[raw] ?? LEVELS.info;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a structured JSON logger bound to a specific module name.
 *
 * Each log method writes a single newline-terminated JSON line to stdout:
 * ```json
 * {"ts":"2026-03-28T12:00:00.000Z","level":"info","module":"ssh-backend","msg":"Connected"}
 * ```
 *
 * Log lines below the configured `COSA_LOG_LEVEL` are suppressed.
 *
 * @param {string} moduleName - The `module` field in every log line.
 * @returns {{ debug: (msg: string) => void,
 *             info:  (msg: string) => void,
 *             warn:  (msg: string) => void,
 *             error: (msg: string) => void }}
 */
function createLogger(moduleName) {
  /**
   * Emit a single log line if the level passes the threshold.
   *
   * @param {'debug'|'info'|'warn'|'error'} level
   * @param {string} msg
   */
  function log(level, msg) {
    if (LEVELS[level] < effectiveLevel()) return;
    process.stdout.write(
      JSON.stringify({
        ts:     new Date().toISOString(),
        level,
        module: moduleName,
        msg,
      }) + '\n'
    );
  }

  /**
   * Map an alert severity to a log level and emit the message. Centralizes
   * the severity→level mapping so different modules can't disagree on
   * whether 'medium' is warn or info. 2026-05-18 review §C Medium #7.
   *
   * @param {'critical'|'high'|'warning'|'medium'|'low'|'info'|string} severity
   * @param {string} msg
   */
  function alert(severity, msg) {
    const s = String(severity || '').toLowerCase();
    const level =
      s === 'critical' || s === 'high'  ? 'error' :
      s === 'warning'  || s === 'medium' ? 'warn'  :
                                           'info';
    log(level, msg);
  }

  return {
    /** @param {string} msg */
    debug: (msg) => log('debug', msg),
    /** @param {string} msg */
    info:  (msg) => log('info',  msg),
    /** @param {string} msg */
    warn:  (msg) => log('warn',  msg),
    /** @param {string} msg */
    error: (msg) => log('error', msg),
    /**
     * Severity-aware convenience: alert('critical', '...') → error,
     * 'warning'/'medium' → warn, 'info'/'low' → info.
     * @param {string} severity
     * @param {string} msg
     */
    alert,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { createLogger };
