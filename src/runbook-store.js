'use strict';

const { getDb }        = require('./session-store');
const { createLogger } = require('./logger');

const log = createLogger('runbook-store');

// ---------------------------------------------------------------------------
// Validation constants
// ---------------------------------------------------------------------------

/** Valid runbook name: lowercase alphanumeric + underscore, 1–64 chars. */
const RUNBOOK_NAME_RE = /^[a-z0-9_]{1,64}$/;
const MAX_LABEL_CHARS = 256;
const MAX_ITER_MIN    = 1;
const MAX_ITER_MAX    = 10;
const VALID_ON_FAILURE = ['alert', 'abort'];

// ---------------------------------------------------------------------------
// Migrations  (mirrors appliance-state-machine.runAsmMigrations; shares session.db)
// ---------------------------------------------------------------------------

const RUNBOOK_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS runbooks (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT UNIQUE NOT NULL,
    description    TEXT NOT NULL,
    steps          TEXT NOT NULL,
    convergence    TEXT,
    max_iterations INTEGER NOT NULL DEFAULT 3,
    on_failure     TEXT NOT NULL DEFAULT 'alert',
    auto_approved  INTEGER NOT NULL DEFAULT 0,
    version        INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS runbook_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    runbook_name  TEXT NOT NULL,
    trigger_ctx   TEXT NOT NULL,
    steps_log     TEXT NOT NULL DEFAULT '[]',
    converged     INTEGER,
    iterations    INTEGER NOT NULL DEFAULT 0,
    outcome       TEXT NOT NULL DEFAULT 'running',
    started_at    TEXT NOT NULL,
    finished_at   TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_runbook_runs_name    ON runbook_runs(runbook_name)`,
  `CREATE INDEX IF NOT EXISTS idx_runbook_runs_started ON runbook_runs(started_at)`,
];

/**
 * Create the runbook tables if they do not yet exist. Idempotent; safe to call
 * on every boot. Shares `session.db` with the rest of COSA.
 */
function runMigrations() {
  const db = getDb();
  const migrate = db.transaction(() => {
    for (const sql of RUNBOOK_MIGRATIONS) db.exec(sql);
  });
  migrate();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now() {
  return new Date().toISOString();
}

function invalid(message) {
  const err = new Error(message);
  err.code  = 'RUNBOOK_INVALID';
  return err;
}

/**
 * Validate an upsert payload, throwing `RUNBOOK_INVALID` on the first problem.
 *
 * @param {object} rb
 */
function validateUpsert(rb) {
  if (typeof rb.name !== 'string' || !RUNBOOK_NAME_RE.test(rb.name)) {
    throw invalid(`Invalid runbook name "${rb.name}" — must match /^[a-z0-9_]{1,64}$/`);
  }
  if (typeof rb.description !== 'string' || rb.description.length === 0 || rb.description.length > MAX_LABEL_CHARS) {
    throw invalid(`Runbook description must be a non-empty string ≤ ${MAX_LABEL_CHARS} characters`);
  }
  if (!Array.isArray(rb.steps) || rb.steps.length === 0) {
    throw invalid('Runbook steps must be a non-empty array');
  }
  for (const [i, step] of rb.steps.entries()) {
    if (!step || typeof step.tool_name !== 'string' || step.tool_name.length === 0) {
      throw invalid(`Step ${i} must have a non-empty tool_name`);
    }
    if (step.input != null && (typeof step.input !== 'object' || Array.isArray(step.input))) {
      throw invalid(`Step ${i} input must be an object`);
    }
  }
  if (rb.convergence != null) {
    const c = rb.convergence;
    if (typeof c.tool_name !== 'string' || typeof c.check_field !== 'string') {
      throw invalid('convergence must have tool_name and check_field');
    }
  }
  const maxIter = rb.maxIterations ?? 3;
  if (!Number.isInteger(maxIter) || maxIter < MAX_ITER_MIN || maxIter > MAX_ITER_MAX) {
    throw invalid(`max_iterations must be an integer in [${MAX_ITER_MIN}, ${MAX_ITER_MAX}]`);
  }
  const onFailure = rb.onFailure ?? 'alert';
  if (!VALID_ON_FAILURE.includes(onFailure)) {
    throw invalid(`on_failure must be one of ${VALID_ON_FAILURE.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// CRUD — runbooks
// ---------------------------------------------------------------------------

/**
 * Create or update a runbook by name. On update, `version` is incremented and
 * `created_at` is preserved.
 *
 * @param {{ name: string, description: string, steps: object[],
 *           convergence?: object|null, maxIterations?: number,
 *           onFailure?: 'alert'|'abort', autoApproved?: boolean }} rb
 * @returns {{ name: string, version: number }}
 */
function upsert(rb) {
  validateUpsert(rb);

  const ts = now();
  getDb()
    .prepare(
      `INSERT INTO runbooks
         (name, description, steps, convergence, max_iterations, on_failure, auto_approved, version, created_at, updated_at)
       VALUES (@name, @description, @steps, @convergence, @max_iterations, @on_failure, @auto_approved, 1, @ts, @ts)
       ON CONFLICT(name) DO UPDATE SET
         description    = excluded.description,
         steps          = excluded.steps,
         convergence    = excluded.convergence,
         max_iterations = excluded.max_iterations,
         on_failure     = excluded.on_failure,
         auto_approved  = excluded.auto_approved,
         version        = runbooks.version + 1,
         updated_at     = excluded.updated_at`
    )
    .run({
      name:           rb.name,
      description:    rb.description,
      steps:          JSON.stringify(rb.steps),
      convergence:    rb.convergence != null ? JSON.stringify(rb.convergence) : null,
      max_iterations: rb.maxIterations ?? 3,
      on_failure:     rb.onFailure ?? 'alert',
      auto_approved:  rb.autoApproved ? 1 : 0,
      ts,
    });

  const row = get(rb.name);
  log.info(`Runbook upserted: ${rb.name} (v${row.version})`);
  return { name: rb.name, version: row.version };
}

/**
 * Fetch a runbook row by name (raw — `steps`/`convergence` are JSON strings).
 *
 * @param {string} name
 * @returns {object|null}
 */
function get(name) {
  return getDb().prepare(`SELECT * FROM runbooks WHERE name = ?`).get(name) ?? null;
}

/**
 * List runbooks with summary metadata only.
 *
 * @returns {Array<{ id: number, name: string, description: string, version: number, updated_at: string }>}
 */
function list() {
  return getDb()
    .prepare(`SELECT id, name, description, version, auto_approved, updated_at FROM runbooks ORDER BY name ASC`)
    .all();
}

/**
 * Delete a runbook by name.
 *
 * @param {string} name
 * @returns {boolean} true if a row was deleted.
 */
function remove(name) {
  const info = getDb().prepare(`DELETE FROM runbooks WHERE name = ?`).run(name);
  if (info.changes > 0) log.info(`Runbook deleted: ${name}`);
  return info.changes > 0;
}

// ---------------------------------------------------------------------------
// CRUD — runbook_runs
// ---------------------------------------------------------------------------

/**
 * Insert a new run row in 'running' state.
 *
 * @param {{ runbook_name: string, trigger_ctx: string }} run
 * @returns {number} the new run id.
 */
function logRun(run) {
  const info = getDb()
    .prepare(
      `INSERT INTO runbook_runs (runbook_name, trigger_ctx, steps_log, iterations, outcome, started_at)
       VALUES (?, ?, '[]', 0, 'running', ?)`
    )
    .run(run.runbook_name, run.trigger_ctx, now());
  return info.lastInsertRowid;
}

/** Columns a run row may be patched with. */
const RUN_PATCH_COLUMNS = ['steps_log', 'converged', 'iterations', 'outcome', 'finished_at'];

/**
 * Patch a run row. Only whitelisted columns are written.
 *
 * @param {number} id
 * @param {object} patch
 */
function updateRun(id, patch) {
  const keys = Object.keys(patch).filter(k => RUN_PATCH_COLUMNS.includes(k));
  if (keys.length === 0) return;
  const setClause = keys.map(k => `${k} = @${k}`).join(', ');
  getDb().prepare(`UPDATE runbook_runs SET ${setClause} WHERE id = @id`).run({ ...patch, id });
}

/**
 * Fetch a run row by id (raw).
 *
 * @param {number} id
 * @returns {object|null}
 */
function getRun(id) {
  return getDb().prepare(`SELECT * FROM runbook_runs WHERE id = ?`).get(id) ?? null;
}

module.exports = {
  runMigrations,
  upsert,
  get,
  list,
  remove,
  logRun,
  updateRun,
  getRun,
  RUNBOOK_NAME_RE,
};
