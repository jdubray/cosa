'use strict';

/**
 * Watcher sandbox worker.
 *
 * Spawned as a child process by watcher-registry.js to execute a single
 * watcher function in complete isolation from the parent COSA process.
 *
 * Two layers of protection:
 *   1. Process boundary  — watcher code cannot reach COSA's credential store,
 *      database connection, approval state, or any other in-memory object.
 *      Even a successful vm escape only reaches this worker's own runtime.
 *   2. vm.createContext  — strips require, process, fetch, and all Node globals
 *      from the watcher function's scope so casual escape attempts fail at the
 *      code level.
 *
 * Protocol:
 *   stdin:  newline-terminated JSON  { code: string, snapshot: object, timeoutMs: number }
 *   stdout: newline-terminated JSON  { triggered: boolean, message?: string }
 *                                OR  { error: string }
 *   exit:   always 0 — errors are communicated via stdout JSON, never via exit code
 */

const vm = require('node:vm');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write a JSON result to stdout and exit cleanly.
 * process.exit(0) is called explicitly so that any async side-effects
 * scheduled by the watcher code (timers, promises) do not keep the
 * worker alive after the response has been written.
 * @param {object} payload
 */
function respond(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exit(0);
}

/**
 * Deep-clone `obj` via JSON round-trip, producing a prototype-free plain
 * object that cannot be used as a prototype-chain escape vector.
 *
 * @param {object} obj
 * @returns {object}
 */
function safeClone(obj) {
  return JSON.parse(JSON.stringify(obj ?? {}));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let rawInput = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { rawInput += chunk; });
process.stdin.on('end', () => {
  let code, snapshot, timeoutMs;

  try {
    ({ code, snapshot, timeoutMs = 200 } = JSON.parse(rawInput));
  } catch {
    respond({ error: 'Worker received invalid JSON input' });
    return;
  }

  if (typeof code !== 'string' || code.length === 0) {
    respond({ error: 'Worker received empty or non-string code' });
    return;
  }

  let result;
  try {
    // The context exposes only a deep-cloned snapshot — no Node globals.
    const context = vm.createContext({ status: safeClone(snapshot) });
    const script  = new vm.Script(`(${code})(status)`, { filename: 'watcher.js' });
    result = script.runInContext(context, { timeout: timeoutMs });
  } catch (err) {
    respond({ error: err.message });
    return;
  }

  // Validate return shape — anything unexpected is treated as not-triggered.
  if (
    result === null ||
    typeof result !== 'object' ||
    typeof result.triggered !== 'boolean'
  ) {
    respond({ triggered: false });
    return;
  }

  respond({
    triggered: result.triggered,
    ...(result.message != null ? { message: String(result.message) } : {}),
  });
});
