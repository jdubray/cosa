'use strict';

const { spawn }        = require('child_process');
const path             = require('path');
const { getDb }        = require('./session-store');
const { getConfig }    = require('../config/cosa.config');
const { createLogger } = require('./logger');

const log = createLogger('watcher-registry');

/** Absolute path to the sandboxed worker script. */
const WORKER_PATH = path.resolve(__dirname, 'watcher-sandbox-worker.js');

// ---------------------------------------------------------------------------
// Sandbox runner
// ---------------------------------------------------------------------------

/**
 * Execute a single watcher function in an isolated child process.
 *
 * The worker (`watcher-sandbox-worker.js`) provides two layers of isolation:
 *   1. Process boundary — watcher code runs in a separate OS process and
 *      cannot access COSA's credential store, database, or any in-memory
 *      state even if it escapes the inner vm context.
 *   2. vm.createContext inside the worker — strips require, process, and
 *      all Node globals from the watcher function's visible scope.
 *
 * The parent sends `{ code, snapshot, timeoutMs }` via stdin and reads the
 * JSON result from stdout.  A SIGKILL is issued if the child does not
 * respond within `timeoutMs * 3` milliseconds (guards against a frozen vm
 * that fails to honour its own timeout, e.g. on some platforms).
 *
 * @param {string} code      - Watcher function source
 * @param {object} snapshot  - Status snapshot passed as `status` to the function
 * @param {number} timeoutMs - vm execution time limit forwarded to the worker
 * @returns {Promise<{ triggered: boolean, message?: string }>}
 */
function runInSandbox(code, snapshot, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Strip parent secrets (ANTHROPIC_API_KEY etc.) from the worker's
      // environment — the sandbox only needs PATH to locate the Node binary.
      env: { PATH: process.env.PATH },
    });

    let stdout  = '';
    let settled = false;

    // Outer kill timer — fires if the worker process hangs without responding
    // (e.g., the vm timeout doesn't fire on this platform).
    // Add a fixed process-startup margin (~500ms) rather than scaling with the
    // vm timeout.  A 3× multiplier would mean a 10 s watcher_timeout_ms creates
    // a 30 s kill delay, blocking the event loop for the entire poll cycle.
    const PROCESS_STARTUP_MARGIN_MS = 500;
    const killTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`Watcher execution timed out after ${timeoutMs}ms`));
    }, timeoutMs + PROCESS_STARTUP_MARGIN_MS);

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });

    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.error) reject(new Error(parsed.error));
        else              resolve(parsed);
      } catch {
        reject(new Error(
          `Watcher worker produced invalid output: ${stdout.slice(0, 200)}`
        ));
      }
    });

    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      reject(err);
    });

    child.stdin.write(JSON.stringify({ code, snapshot, timeoutMs }));
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Validation constants
// ---------------------------------------------------------------------------

/** Valid watcher id: lowercase alphanumeric + underscore, 1–64 chars. */
const WATCHER_ID_RE = /^[a-z0-9_]{1,64}$/;

/** Maximum allowed code length (bytes). Prevents storing multi-MB functions. */
const MAX_CODE_BYTES = 8192;

/** Maximum length for name and description fields. */
const MAX_LABEL_CHARS = 256;

// ---------------------------------------------------------------------------
// WatcherRegistry class
// ---------------------------------------------------------------------------

/**
 * Persistent registry of named monitoring conditions (watchers).
 *
 * Each watcher is a JavaScript function stored in `session.db`.  On every
 * `appliance_status_poll` cycle all enabled watchers are executed inside a
 * `node:vm` sandbox against the fresh status snapshot.  Triggered alerts are
 * subject to a per-watcher cooldown before they are surfaced.
 *
 * Instantiate once at boot and share the singleton via module exports.
 */
class WatcherRegistry {
  constructor() {
    // Compiled statement cache — populated lazily on first use.
    this._stmts = null;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Lazily prepare and cache all statements against the live DB. */
  _db() {
    return getDb();
  }

  _stmtCache() {
    if (this._stmts) return this._stmts;
    const db = this._db();
    this._stmts = {
      upsert: db.prepare(`
        INSERT INTO watchers (id, name, description, code, runbook_name, created_at, enabled)
        VALUES (@id, @name, @description, @code, @runbook_name, @created_at, 1)
        ON CONFLICT(id) DO UPDATE SET
          name         = excluded.name,
          description  = excluded.description,
          code         = excluded.code,
          runbook_name = excluded.runbook_name,
          enabled      = 1
      `),
      listAll: db.prepare(`
        SELECT * FROM watchers ORDER BY created_at ASC
      `),
      listEnabled: db.prepare(`
        SELECT * FROM watchers WHERE enabled = 1 ORDER BY created_at ASC
      `),
      setEnabled: db.prepare(`
        UPDATE watchers SET enabled = @enabled WHERE id = @id
      `),
      remove: db.prepare(`
        DELETE FROM watchers WHERE id = @id
      `),
      markTriggered: db.prepare(`
        UPDATE watchers
        SET last_triggered_at = @ts,
            trigger_count     = trigger_count + 1
        WHERE id = @id
      `),
      // Atomic cooldown gate: only writes the alert timestamp if the watcher
       // has not been alerted since @cutoff. .changes returns 1 if the alert
       // is fresh, 0 if a concurrent runAll() already marked it. Replaces the
       // prior read-then-write pattern that could surface duplicate alerts
       // when two runAll() calls overlapped (2026-05-18 review §B P2 #10).
      markAlertedIfFresh: db.prepare(`
        UPDATE watchers
        SET last_alerted_at = @ts
        WHERE id = @id
          AND (last_alerted_at IS NULL OR last_alerted_at < @cutoff)
      `),
    };
    return this._stmts;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Store a new watcher or replace an existing one with the same `id`.
   *
   * Validates all fields before writing to ensure that malformed or
   * excessively large input from the LLM is caught early with a clear error.
   *
   * @param {{ id: string, name: string, description: string, code: string,
   *           runbook_name?: string }} watcher
   *   `runbook_name` optionally binds the watcher to a deterministic runbook
   *   that runs (instead of an LLM session) when the watcher fires.
   * @returns {Promise<void>}
   * @throws {Error} `code:'WATCHER_INVALID'` when any field fails validation
   */
  async register({ id, name, description, code, runbook_name }) {
    if (typeof id !== 'string' || !WATCHER_ID_RE.test(id)) {
      const err  = new Error(
        `Invalid watcher id "${id}" — must match /^[a-z0-9_]{1,64}$/`
      );
      err.code   = 'WATCHER_INVALID';
      throw err;
    }
    if (typeof code !== 'string' || code.length === 0) {
      const err  = new Error('Watcher code must be a non-empty string');
      err.code   = 'WATCHER_INVALID';
      throw err;
    }
    if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
      const err  = new Error(
        `Watcher code exceeds the ${MAX_CODE_BYTES}-byte limit ` +
        `(got ${Buffer.byteLength(code, 'utf8')} bytes)`
      );
      err.code   = 'WATCHER_INVALID';
      throw err;
    }
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_LABEL_CHARS) {
      const err  = new Error(`Watcher name must be a non-empty string ≤ ${MAX_LABEL_CHARS} characters`);
      err.code   = 'WATCHER_INVALID';
      throw err;
    }
    if (typeof description !== 'string' || description.length === 0 || description.length > MAX_LABEL_CHARS) {
      const err  = new Error(`Watcher description must be a non-empty string ≤ ${MAX_LABEL_CHARS} characters`);
      err.code   = 'WATCHER_INVALID';
      throw err;
    }

    if (runbook_name != null &&
        (typeof runbook_name !== 'string' || !WATCHER_ID_RE.test(runbook_name))) {
      const err = new Error(`Invalid runbook_name "${runbook_name}" — must match /^[a-z0-9_]{1,64}$/`);
      err.code  = 'WATCHER_INVALID';
      throw err;
    }

    const stmts = this._stmtCache();
    stmts.upsert.run({
      id,
      name,
      description,
      code,
      runbook_name: runbook_name ?? null,
      created_at: new Date().toISOString(),
    });
    log.info(`Watcher registered: ${id} — "${name}"${runbook_name ? ` (runbook: ${runbook_name})` : ''}`);
  }

  /**
   * Run all enabled watchers against a status snapshot.
   *
   * Watchers that fire AND have passed their cooldown window are included in
   * `alerts[]` and their `last_alerted_at` is updated.  Watchers that fire but
   * are still within the cooldown window are tracked (trigger_count updated)
   * but not surfaced as alerts.
   *
   * @param {object} statusSnapshot - Raw JSON from the appliance status endpoint
   * @returns {Promise<{
   *   alerts:             Array<{ watcher_id: string, watcher_name: string, message: string, triggered_at: string }>,
   *   errors:             Array<{ watcher_id: string, error: string }>,
   *   watchers_evaluated: number
   * }>}
   */
  async runAll(statusSnapshot) {
    const { appliance } = getConfig();
    const toolCfg    = appliance.tools?.appliance_status_poll ?? {};
    const timeoutMs  = toolCfg.watcher_timeout_ms  ?? 200;
    const cooldownMs = (toolCfg.alert_cooldown_minutes ?? 30) * 60 * 1000;

    const stmts   = this._stmtCache();
    const watchers = stmts.listEnabled.all();

    const now = new Date();

    // Run all sandboxed watchers concurrently — each is already an isolated
    // child process so there is no shared mutable state between them.
    const results = await Promise.allSettled(
      watchers.map(w => runInSandbox(w.code, statusSnapshot, timeoutMs))
    );

    const alerts = [];
    const errors = [];

    for (let i = 0; i < watchers.length; i++) {
      const w      = watchers[i];
      const result = results[i];

      if (result.status === 'rejected') {
        log.warn(`Watcher "${w.id}" threw: ${result.reason.message}`);
        errors.push({ watcher_id: w.id, error: result.reason.message });
        continue;
      }

      const outcome = result.value;
      if (!outcome.triggered) continue;

      const triggeredAt = now.toISOString();
      stmts.markTriggered.run({ id: w.id, ts: triggeredAt });

      // Atomic cooldown gate. SQLite serializes writers, so concurrent
      // runAll() calls cannot both pass the check — only one will see
      // changes === 1 and emit the alert.
      const cutoffIso = new Date(now.getTime() - cooldownMs).toISOString();
      const upd = stmts.markAlertedIfFresh.run({ id: w.id, ts: triggeredAt, cutoff: cutoffIso });
      if (upd.changes === 0) {
        log.debug(`Watcher "${w.id}" triggered but within cooldown — suppressed`);
        continue;
      }

      alerts.push({
        watcher_id:   w.id,
        watcher_name: w.name,
        message:      outcome.message ?? `Watcher "${w.name}" triggered`,
        triggered_at: triggeredAt,
        runbook_name: w.runbook_name ?? null,
      });
    }

    return { alerts, errors, watchers_evaluated: watchers.length };
  }

  /**
   * List all watchers (enabled and disabled).
   *
   * @returns {Promise<Array<object>>}
   */
  async list() {
    return this._stmtCache().listAll.all();
  }

  /**
   * Enable or disable a watcher by id.
   *
   * @param {string} id
   * @param {boolean} enabled
   * @returns {Promise<void>}
   * @throws {Error} `code:'WATCHER_NOT_FOUND'` if no watcher exists with this id
   */
  async setEnabled(id, enabled) {
    const result = this._stmtCache().setEnabled.run({ id, enabled: enabled ? 1 : 0 });
    if (result.changes === 0) {
      const err  = new Error(`Watcher "${id}" not found`);
      err.code   = 'WATCHER_NOT_FOUND';
      throw err;
    }
    log.info(`Watcher "${id}" ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Permanently delete a watcher by id.
   *
   * @param {string} id
   * @returns {Promise<void>}
   * @throws {Error} `code:'WATCHER_NOT_FOUND'` if no watcher exists with this id
   */
  async remove(id) {
    const result = this._stmtCache().remove.run({ id });
    if (result.changes === 0) {
      const err  = new Error(`Watcher "${id}" not found`);
      err.code   = 'WATCHER_NOT_FOUND';
      throw err;
    }
    log.info(`Watcher "${id}" removed`);
  }

  /**
   * Invalidate the statement cache (for use in tests after DB is swapped).
   * @internal
   */
  /**
   * Install version-controlled watcher definitions from config/watcher-seeds.js
   * for any watcher id not already present. Existing watchers — and their
   * enabled/disabled state and any live edits — are left untouched, so this
   * repopulates a fresh/rebuilt session.db without clobbering a running system.
   * Idempotent.
   *
   * @returns {Promise<{ installed: string[] }>}
   */
  async installSeedWatchers() {
    let seeds;
    try {
      seeds = require('../config/watcher-seeds');
    } catch (err) {
      log.warn(`Watcher seeds not loaded: ${err.message}`);
      return { installed: [] };
    }
    if (!Array.isArray(seeds)) {
      log.warn('config/watcher-seeds.js did not export an array — skipping');
      return { installed: [] };
    }

    const existing  = new Set(this._stmtCache().listAll.all().map(w => w.id));
    const installed = [];
    for (const seed of seeds) {
      if (existing.has(seed.id)) continue;   // preserve live watcher + its state
      await this.register({
        id:           seed.id,
        name:         seed.name,
        description:  seed.description,
        code:         seed.code,
        runbook_name: seed.runbook_name ?? null,
      });
      // register() enables by default; honor a seed that ships disabled.
      if (seed.enabled === false) await this.setEnabled(seed.id, false);
      installed.push(seed.id);
      log.info(`Seeded watcher: ${seed.id} (enabled=${seed.enabled !== false})`);
    }
    return { installed };
  }

  _resetCache() {
    this._stmts = null;
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

module.exports = new WatcherRegistry();
