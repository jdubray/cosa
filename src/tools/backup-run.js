'use strict';

const sshBackend = require('../ssh-backend');
const { getConfig } = require('../../config/cosa.config');
const { createLogger } = require('../logger');

const log = createLogger('backup-run');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME       = 'backup_run';
const RISK_LEVEL = 'read';

const DEFAULT_TIMEOUT_S  = 120;
const DEFAULT_BACKUP_DIR = '/tmp/cosa-backups';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const INPUT_SCHEMA = {
  type:                 'object',
  properties:           {},
  required:             [],
  additionalProperties: false,
};

const SCHEMA = {
  description:
    'Export one or more appliance database tables to timestamped JSONL files ' +
    'on the appliance, writing a .sha256 sidecar for each.  Tables and the JS ' +
    'runtime used for serialization are configurable in appliance.yaml.  ' +
    'Before the backup runs, the tool queries sqlite_master to filter out any ' +
    'configured tables that no longer exist in the schema (schema drift is a ' +
    'warning, not a failure). Returns backup_files (one entry per backed-up ' +
    'table with path, row_count, checksum), skipped_tables (configured but ' +
    'missing from the DB), and timing. Returns success: false with a ' +
    'structured error on SSH, discovery, or script failure — does not throw.',
  inputSchema: INPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert an ISO timestamp to a filename-safe string by replacing colons and
 * dots with hyphens.
 *
 * Example: "2026-03-29T20:43:27.360Z" → "2026-03-29T20-43-27-360Z"
 *
 * @param {string} iso
 * @returns {string}
 */
function isoToFileTs(iso) {
  return iso.replace(/:/g, '-').replace(/\./g, '-');
}

/**
 * Single-quote-escape a shell argument so it is safe to embed inside a
 * single-quoted bash string.
 *
 * @param {string} value
 * @returns {string}
 */
function shEscape(value) {
  return value.replace(/'/g, "'\\''");
}

/**
 * Build the multi-step bash script that exports N tables as JSONL.
 *
 * For each table the script:
 *   1. Exports sqlite3 JSON to a temp file
 *   2. Transforms the temp file (via stdin redirect) to JSONL via the JS runtime
 *   3. Counts rows via wc -l
 *   4. Computes SHA-256 via sha256sum
 *   5. Writes a "<hash>  <filename>" sidecar file
 *   6. Prints two lines on stdout: row_count\nchecksum
 *   7. Removes the temp file
 *
 * Total stdout is 2×N lines in table order, parsed by the handler.
 *
 * Using a temp file + stdin redirect (rather than a direct pipe) avoids pipe
 * contention with the bash -s stdin channel.  When bash reads its script from
 * stdin, a direct `sqlite3 | bun` pipe can cause bun's process.stdin to see
 * EOF before any data arrives — redirecting `< tmpfile` sidesteps this entirely.
 *
 * The `runtimeExpr` is a shell expression that evaluates to the JS binary
 * path.  A configured value is a single-quoted literal (e.g. `'bun'`);
 * the auto-detect fallback is a `$(which ...)` subshell.
 *
 * @param {string}   dbPath
 * @param {string}   backupDir
 * @param {string[]} tables
 * @param {string}   fileTs       - Timestamp slug shared across all output filenames
 * @param {string}   runtimeExpr  - Shell expression evaluating to the JS binary path
 * @returns {string}
 */
function buildScript(dbPath, backupDir, tables, fileTs, runtimeExpr) {
  const qDb  = `'${shEscape(dbPath)}'`;
  const qDir = `'${shEscape(backupDir)}'`;

  // Single-line JSONL transformer — reads from stdin.
  // Stdin is redirected from a temp file (see below) rather than piped
  // directly from sqlite3, so there is no pipe contention with the bash -s
  // stdin channel.  Works identically under both Node.js and Bun.
  //
  // Guards against empty input: sqlite3 -json outputs 0 bytes (not `[]`) for
  // empty tables on some platforms.  An empty string would cause JSON.parse to
  // throw "Unexpected EOF", aborting the whole backup job.
  const jsTransformCode =
    `"let d='';process.stdin.on('data',c=>d+=c)` +
    `.on('end',()=>{if(!d.trim())return;JSON.parse(d).forEach(r=>console.log(JSON.stringify(r)))})"`;

  const tableSteps = tables.map(table => {
    const backupFile  = `${table}_${fileTs}.jsonl`;
    const backupPath  = `${backupDir}/${backupFile}`;
    const sidecarPath = `${backupPath}.sha256`;
    const qBackup     = `'${shEscape(backupPath)}'`;
    const qSidecar    = `'${shEscape(sidecarPath)}'`;
    // Table names come from operator-controlled appliance.yaml — not user input.
    const qTable      = shEscape(table);

    return [
      `TMPJSON=$(mktemp)`,
      `sqlite3 -json ${qDb} 'SELECT * FROM ${qTable}' > "$TMPJSON"`,
      `"$JSRT" -e ${jsTransformCode} < "$TMPJSON" > ${qBackup}`,
      `rm -f "$TMPJSON"`,
      `ROW_COUNT=$(wc -l < ${qBackup} | tr -d ' ')`,
      `CHECKSUM=$(sha256sum ${qBackup} | awk '{print $1}')`,
      `printf '%s  ${backupFile}\\n' "$CHECKSUM" > ${qSidecar}`,
      `printf '%s\\n%s\\n' "$ROW_COUNT" "$CHECKSUM"`,
    ].join('\n');
  });

  return [
    'set -euo pipefail',
    `JSRT=${runtimeExpr}`,
    `[ -z "$JSRT" ] && { echo "No JS runtime (bun/node) found in PATH" >&2; exit 1; }`,
    `mkdir -p ${qDir}`,
    ...tableSteps,
  ].join('\n');
}

/**
 * Discover the set of user tables that currently exist in the appliance DB.
 *
 * Used to filter the configured `tables` list before building the main backup
 * script. This turns schema drift (a table was renamed or dropped upstream)
 * from a hard abort — `set -euo pipefail` kills the whole backup on the first
 * sqlite3 "no such table" error — into a non-fatal warning: we skip the missing
 * table and back up the rest.
 *
 * Returns `null` if discovery itself failed (SSH or sqlite3 error); the caller
 * treats that as a backup failure and surfaces it to the operator.
 *
 * @param {string} dbPath
 * @returns {Promise<Set<string> | null>}
 */
async function discoverExistingTables(dbPath) {
  const qDb = `'${shEscape(dbPath)}'`;
  const cmd =
    `sqlite3 ${qDb} ` +
    `"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"`;

  let result;
  try {
    result = await sshBackend.exec(cmd);
  } catch {
    return null;
  }
  if (result.exitCode !== 0) return null;

  return new Set(
    result.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  );
}

/**
 * Race an SSH exec against a hard timeout.
 *
 * @param {string}      command
 * @param {string|null} stdin
 * @param {number}      timeoutMs
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
 */
function execWithTimeout(command, stdin, timeoutMs) {
  const execPromise    = sshBackend.exec(command, stdin);
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error(`Backup timed out after ${timeoutMs}ms`)),
      timeoutMs
    )
  );
  return Promise.race([execPromise, timeoutPromise]);
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

/**
 * Trigger a backup of the configured appliance database tables.
 *
 * On SSH or script failure the function returns `{ success: false, error }`
 * instead of throwing, so the agent can report the failure gracefully.
 *
 * @returns {Promise<{
 *   success:      boolean,
 *   backup_files: Array<{ table: string, path: string, row_count: number|null, checksum: string|null }>,
 *   started_at:   string,
 *   completed_at: string,
 *   duration_ms:  number,
 *   error?:       string,
 * }>}
 */
async function handler() {
  const { appliance } = getConfig();
  const dbPath    = appliance.database.path;
  const backupDir = appliance.tools?.backup_run?.backup_dir ?? DEFAULT_BACKUP_DIR;
  const timeoutMs = (appliance.tools?.backup_run?.timeout_s ?? DEFAULT_TIMEOUT_S) * 1000;
  const tables    = appliance.tools?.backup_run?.tables     ?? null;
  const jsRuntime = appliance.tools?.backup_run?.js_runtime ?? null;

  if (!Array.isArray(tables) || tables.length === 0) {
    return {
      success:      false,
      backup_files: [],
      started_at:   new Date().toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms:  0,
      error:        'backup_run.tables is not configured in appliance.yaml — ' +
                    'add the list of database tables to export (e.g. tables: [readings])',
    };
  }

  // Build the shell expression that resolves to the JS runtime path.
  // A configured value is used as a literal (single-quoted to prevent word
  // splitting); the auto-detect subshell prefers bun, then falls back to node.
  const runtimeExpr = jsRuntime
    ? `'${shEscape(jsRuntime)}'`
    : `$(which bun 2>/dev/null || which node 2>/dev/null || echo '')`;

  const startedAt = new Date().toISOString();
  const startMs   = Date.now();
  const fileTs    = isoToFileTs(startedAt);

  // ── Schema-drift guard ────────────────────────────────────────────────────
  // Query sqlite_master first so that a stale configured table name (dropped
  // upstream) becomes a skipped-with-warning, not a fail-the-entire-backup.
  const existing = await discoverExistingTables(dbPath);
  if (existing === null) {
    return {
      success:      false,
      backup_files: [],
      started_at:   startedAt,
      completed_at: new Date().toISOString(),
      duration_ms:  Date.now() - startMs,
      error:        'Failed to enumerate tables from sqlite_master — aborting before backup.',
    };
  }

  const skippedTables  = tables.filter((t) => !existing.has(t));
  const tablesToBackup = tables.filter((t) =>  existing.has(t));

  if (skippedTables.length > 0) {
    log.warn(
      `Skipping ${skippedTables.length} configured table(s) missing from DB: ` +
      `[${skippedTables.join(', ')}]. Update appliance.yaml to remove them.`
    );
  }

  if (tablesToBackup.length === 0) {
    return {
      success:        false,
      backup_files:   [],
      skipped_tables: skippedTables,
      started_at:     startedAt,
      completed_at:   new Date().toISOString(),
      duration_ms:    Date.now() - startMs,
      error:
        `None of the configured tables exist in the DB. ` +
        `Configured: [${tables.join(', ')}]. ` +
        `Existing (sample): [${[...existing].slice(0, 10).join(', ')}${existing.size > 10 ? ', ...' : ''}].`,
    };
  }

  const script = buildScript(dbPath, backupDir, tablesToBackup, fileTs, runtimeExpr);

  // ── Execute backup script via SSH ─────────────────────────────────────────
  let execResult;
  try {
    execResult = await execWithTimeout('bash -s', script, timeoutMs);
  } catch (err) {
    return {
      success:      false,
      backup_files: [],
      started_at:   startedAt,
      completed_at: new Date().toISOString(),
      duration_ms:  Date.now() - startMs,
      error:        err.message,
    };
  }

  const { stdout, stderr, exitCode } = execResult;
  const completedAt = new Date().toISOString();
  const durationMs  = Date.now() - startMs;

  if (exitCode !== 0) {
    return {
      success:      false,
      backup_files: [],
      started_at:   startedAt,
      completed_at: completedAt,
      duration_ms:  durationMs,
      error:        `Backup script exited ${exitCode}: ${stderr.trim()}`,
    };
  }

  // ── Parse 2×N output lines: row_count\nchecksum per backed-up table ───────
  const lines = stdout.trim().split('\n');
  const backupFiles = tablesToBackup.map((table, i) => {
    const backupFile = `${table}_${fileTs}.jsonl`;
    const rowCount   = parseInt(lines[i * 2], 10);
    const checksum   = (lines[i * 2 + 1] ?? '').trim();
    return {
      table,
      path:      `${backupDir}/${backupFile}`,
      row_count: isNaN(rowCount) ? null : rowCount,
      checksum:  checksum || null,
    };
  });

  return {
    success:        true,
    backup_files:   backupFiles,
    skipped_tables: skippedTables,
    started_at:     startedAt,
    completed_at:   completedAt,
    duration_ms:    durationMs,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
