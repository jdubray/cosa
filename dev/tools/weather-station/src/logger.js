'use strict';

/**
 * Minimal structured logger. Outputs newline-delimited JSON to stdout.
 * Matches COSA's logger.js field names so log lines look consistent.
 *
 * @param {string} module
 * @returns {{ info, warn, error, debug }}
 */
function createLogger(module) {
  const write = (level, msg, ctx) => {
    const entry = { ts: new Date().toISOString(), level, module, msg, ...ctx };
    process.stdout.write(JSON.stringify(entry) + '\n');
  };

  return {
    info:  (msg, ctx = {}) => write('info',  msg, ctx),
    warn:  (msg, ctx = {}) => write('warn',  msg, ctx),
    error: (msg, ctx = {}) => write('error', msg, ctx),
    debug: (msg, ctx = {}) => {
      if (process.env.NODE_ENV !== 'production') write('debug', msg, ctx);
    },
  };
}

module.exports = { createLogger };
