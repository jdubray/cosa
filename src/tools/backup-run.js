'use strict';

const sshBackend = require('../ssh-backend');
const { getConfig } = require('../../config/cosa.config');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME       = 'backup_run';
const RISK_LEVEL = 'medium';

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
    'Export the WeatherStation readings table to a timestamped JSONL file on ' +
    'the appliance, then write a .sha256 sidecar.  Returns the backup path, ' +
    'row count, SHA-256 checksum, and timing.  Returns success: false with an ' +
    'error message on SSH or script failure — does not throw.',
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
 * single-quoted bash string.  The path must not be empty.
 *
 * @param {string} value
 * @returns {string}
 */
function shEscape(value) {
  // End single quote, add escaped quote, re-open single quote.
  return value.replace(/'/g, "'\\''");
}

/**
 * Build the multi-step bash script that:
 *   1. Creates the backup directory.
 *   2. Exports the readings table as JSONL using sqlite3 + Node.js transformer.
 *   3. Counts rows via wc -l.
 *   4. Computes SHA-256 via sha256sum.
 *   5. Writes a "<hash>  <filename>" sidecar file.
 *   6. Prints row-count and checksum on stdout (two lines) for the caller.
 *
 * Node.js is used as the JSON-array → JSONL transformer because it is
 * guaranteed to be installed on the WeatherStation appliance.
 *
 * SQL is embedded directly (static string — no user input involved) to avoid
 * the stdin-consumed-by-bash-s problem that would prevent piping.
 *
 * @param {string} dbPath
 * @param {string} backupDir
 * @param {string} backupPath  - Full path to the .jsonl file.
 * @param {string} sidecarPath - Full path to the .sha256 file.
 * @param {string} backupFile  - Basename only (used in sidecar content).
 * @returns {string}
 */
function buildScript(dbPath, backupDir, backupPath, sidecarPath, backupFile) {
  const qDb      = `'${shEscape(dbPath)}'`;
  const qDir     = `'${shEscape(backupDir)}'`;
  const qBackup  = `'${shEscape(backupPath)}'`;
  const qSidecar = `'${shEscape(sidecarPath)}'`;

  // Single-line Node.js JSONL transformer — avoids quoting issues with
  // multi-line python or heredoc approaches.
  const nodeTransform =
    `node -e "let d='';process.stdin.on('data',c=>d+=c)` +
    `.on('end',()=>JSON.parse(d).forEach(r=>console.log(JSON.stringify(r))))"`;

  return [
    'set -euo pipefail',
    `mkdir -p ${qDir}`,
    `sqlite3 -json ${qDb} 'SELECT * FROM readings' | ${nodeTransform} > ${qBackup}`,
    `ROW_COUNT=$(wc -l < ${qBackup} | tr -d ' ')`,
    `CHECKSUM=$(sha256sum ${qBackup} | awk '{print $1}')`,
    `printf '%s  ${backupFile}\\n' "$CHECKSUM" > ${qSidecar}`,
    `printf '%s\\n%s\\n' "$ROW_COUNT" "$CHECKSUM"`,
  ].join('\n');
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
 * Trigger a backup of the appliance readings table.
 *
 * On SSH or script failure the function returns `{ success: false, error }`
 * instead of throwing, so the agent can report the failure gracefully.
 *
 * @returns {Promise<{
 *   success:      boolean,
 *   backup_path:  string|null,
 *   row_count:    number|null,
 *   checksum:     string|null,
 *   started_at:   string,
 *   completed_at: string,
 *   duration_ms:  number,
 *   error?:       string,
 * }>}
 */
async function handler() {
  const { appliance } = getConfig();
  const dbPath     = appliance.database.path;
  const backupDir  = appliance.tools?.backup_run?.backup_dir  ?? DEFAULT_BACKUP_DIR;
  const timeoutMs  = (appliance.tools?.backup_run?.timeout_s  ?? DEFAULT_TIMEOUT_S) * 1000;

  const startedAt  = new Date().toISOString();
  const startMs    = Date.now();

  const fileTs     = isoToFileTs(startedAt);
  const backupFile = `readings_${fileTs}.jsonl`;
  const backupPath = `${backupDir}/${backupFile}`;
  const sidecarPath = `${backupPath}.sha256`;

  const script = buildScript(dbPath, backupDir, backupPath, sidecarPath, backupFile);

  // ── Execute backup script via SSH ─────────────────────────────────────────
  let execResult;
  try {
    execResult = await execWithTimeout('bash -s', script, timeoutMs);
  } catch (err) {
    const completedAt = new Date().toISOString();
    return {
      success:      false,
      backup_path:  null,
      row_count:    null,
      checksum:     null,
      started_at:   startedAt,
      completed_at: completedAt,
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
      backup_path:  null,
      row_count:    null,
      checksum:     null,
      started_at:   startedAt,
      completed_at: completedAt,
      duration_ms:  durationMs,
      error:        `Backup script exited ${exitCode}: ${stderr.trim()}`,
    };
  }

  // ── Parse two-line output: row_count\nchecksum ────────────────────────────
  const lines    = stdout.trim().split('\n');
  const rowCount = parseInt(lines[0], 10);
  const checksum = (lines[1] ?? '').trim();

  return {
    success:      true,
    backup_path:  backupPath,
    row_count:    isNaN(rowCount) ? null : rowCount,
    checksum:     checksum || null,
    started_at:   startedAt,
    completed_at: completedAt,
    duration_ms:  durationMs,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
