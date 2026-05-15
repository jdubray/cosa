'use strict';

const path = require('path');
const sshBackend = require('../ssh-backend');
const { getConfig } = require('../../config/cosa.config');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME       = 'backup_verify';
const RISK_LEVEL = 'read';

const DEFAULT_BACKUP_DIR = '/tmp/cosa-backups';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    backup_path: {
      type:        'string',
      description:
        'Absolute path to the .jsonl backup file to verify. ' +
        'If omitted, the most recent *.jsonl file in the ' +
        'configured backup directory is used.',
    },
    prefix: {
      type:        'string',
      description:
        'Optional filename prefix used to scope auto-detection to one ' +
        'database in multi-DB mode (e.g. "campaigns__"). The glob becomes ' +
        '<backup_dir>/<prefix>*.jsonl, so only files belonging to that DB ' +
        'are considered. Ignored when backup_path is provided.',
    },
  },
  required:             [],
  additionalProperties: false,
};

const SCHEMA = {
  description:
    'Verify the integrity of a backup by re-computing its SHA-256 checksum ' +
    'and comparing it against the .sha256 sidecar written by backup_run. ' +
    'Returns verified, backup_path, expected_hash, actual_hash, row_count, ' +
    'file_size_kb, and backup_age_hours. ' +
    'Returns verified: false (does not throw) when checksums do not match. ' +
    'Throws when no backup file can be found.',
  inputSchema: INPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Single-quote-escape a shell argument.
 * @param {string} value
 * @returns {string}
 */
function shEscape(value) {
  return value.replace(/'/g, "'\\''");
}

/**
 * Build the verification bash script.
 *
 * The script:
 *   1. Locates the target backup file (override or most-recent glob).
 *   2. Reads the expected SHA-256 from the .sha256 sidecar.
 *   3. Re-computes the actual SHA-256 via sha256sum.
 *   4. Collects row_count (wc -l), file_size (stat), and mtime (stat).
 *   5. Prints KEY=VALUE pairs on stdout for the caller to parse.
 *   6. Prints NO_BACKUP_FOUND and exits 0 when no file is available.
 *
 * @param {string}      backupDir          - Configured backup directory.
 * @param {string|null} backupPathOverride - Explicit path, or null for auto-detect.
 * @returns {string}
 */
function buildScript(backupDir, backupPathOverride, prefix = '') {
  const qDir = `'${shEscape(backupDir)}'`;

  // Locate the target file — either the explicit override or the most recent
  // glob, optionally scoped to one database via a filename prefix.
  const safePrefix = prefix.replace(/[^A-Za-z0-9_.\-]/g, '');
  const glob = safePrefix
    ? `${qDir}/${safePrefix}*.jsonl`
    : `${qDir}/*.jsonl`;
  const locateBlock = backupPathOverride
    ? `BACKUP_PATH='${shEscape(backupPathOverride)}'`
    : [
        `BACKUP_PATH=""`,
        `if ls ${glob} 1>/dev/null 2>&1; then`,
        `  BACKUP_PATH=$(ls -t ${glob} | head -1)`,
        `fi`,
      ].join('\n');

  return [
    'set -euo pipefail',
    '',
    locateBlock,
    '',
    '# Report missing backup without error exit so the caller can throw.',
    'if [ -z "$BACKUP_PATH" ] || [ ! -f "$BACKUP_PATH" ]; then',
    '  printf "NO_BACKUP_FOUND\\n"',
    '  exit 0',
    'fi',
    '',
    '# Read expected hash from .sha256 sidecar (field 1 of sha256sum-format line).',
    'SIDECAR="${BACKUP_PATH}.sha256"',
    'if [ -f "$SIDECAR" ]; then',
    "  EXPECTED=$(awk '{print $1}' \"$SIDECAR\")",
    'else',
    '  EXPECTED=""',
    'fi',
    '',
    '# Recompute actual hash.',
    "ACTUAL=$(sha256sum \"$BACKUP_PATH\" | awk '{print $1}')",
    '',
    '# Row count, file size, and modification time.',
    "ROW_COUNT=$(wc -l < \"$BACKUP_PATH\" | tr -d ' ')",
    'FILE_SIZE=$(stat -c%s "$BACKUP_PATH")',
    'MTIME=$(stat -c%Y "$BACKUP_PATH")',
    'NOW=$(date +%s)',
    '',
    'printf "BACKUP_PATH=%s\\n" "$BACKUP_PATH"',
    'printf "EXPECTED=%s\\n" "$EXPECTED"',
    'printf "ACTUAL=%s\\n" "$ACTUAL"',
    'printf "ROW_COUNT=%s\\n" "$ROW_COUNT"',
    'printf "FILE_SIZE=%s\\n" "$FILE_SIZE"',
    'printf "MTIME=%s\\n" "$MTIME"',
    'printf "NOW=%s\\n" "$NOW"',
  ].join('\n');
}

/**
 * Parse KEY=VALUE lines from the script's stdout into a plain object.
 * Only the first `=` is treated as the separator so values may contain `=`.
 *
 * @param {string} stdout
 * @returns {Record<string, string>}
 */
function parseOutput(stdout) {
  const result = {};
  for (const line of stdout.trim().split('\n')) {
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    result[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return result;
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
      () => reject(new Error(`backup_verify timed out after ${timeoutMs}ms`)),
      timeoutMs
    )
  );
  return Promise.race([execPromise, timeoutPromise]);
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

/**
 * Verify the integrity of the most recent (or specified) backup.
 *
 * @param {{ backup_path?: string }} [input]
 * @returns {Promise<{
 *   verified:          boolean,
 *   backup_path:       string,
 *   expected_hash:     string|null,
 *   actual_hash:       string|null,
 *   row_count:         number|null,
 *   file_size_kb:      number|null,
 *   backup_age_hours:  number|null,
 * }>}
 * @throws {Error} When no backup file is found, or on SSH/script failure.
 */
async function handler({ backup_path: backupPathArg, prefix } = {}) {
  const { appliance } = getConfig();
  const backupDir = appliance.tools?.backup_run?.backup_dir ?? DEFAULT_BACKUP_DIR;
  const timeoutMs = (appliance.tools?.backup_run?.timeout_s ?? 120) * 1000;

  // ── Validate backup_path when caller supplies one ─────────────────────────
  // Normalise using POSIX rules (paths live on the remote Linux appliance).
  // This resolves '..' segments and double slashes before any checks, so
  // inputs like '/tmp/cosa-backups/../secret.jsonl' are caught by the
  // prefix test rather than requiring a separate '..' scan.
  const normalisedPath = backupPathArg != null
    ? path.posix.normalize(backupPathArg)
    : null;

  if (normalisedPath != null) {
    if (!normalisedPath.endsWith('.jsonl')) {
      throw new Error(
        `backup_verify: backup_path must end with .jsonl (got: ${backupPathArg})`
      );
    }
    const safeDir = path.posix.normalize(backupDir);
    if (!normalisedPath.startsWith(safeDir + '/')) {
      throw new Error(
        `backup_verify: backup_path must be inside ${safeDir} (got: ${backupPathArg})`
      );
    }
  }

  const script = buildScript(backupDir, normalisedPath, prefix ?? '');

  // ── Execute via SSH ────────────────────────────────────────────────────────
  let execResult;
  try {
    execResult = await execWithTimeout('bash -s', script, timeoutMs);
  } catch (err) {
    throw new Error(`backup_verify SSH error: ${err.message}`);
  }

  const { stdout, stderr, exitCode } = execResult;

  if (exitCode !== 0) {
    throw new Error(`backup_verify script exited ${exitCode}: ${stderr.trim()}`);
  }

  // ── Handle missing backup ──────────────────────────────────────────────────
  if (stdout.trim() === 'NO_BACKUP_FOUND') {
    throw new Error('No backup file found in the configured backup directory.');
  }

  // ── Parse output ──────────────────────────────────────────────────────────
  const parsed = parseOutput(stdout);

  if (!parsed.BACKUP_PATH) {
    throw new Error('No backup file found in the configured backup directory.');
  }

  const expectedHash  = parsed.EXPECTED ?? '';
  const actualHash    = parsed.ACTUAL   ?? '';
  const rowCount      = parseInt(parsed.ROW_COUNT, 10);
  const fileSizeBytes = parseInt(parsed.FILE_SIZE,  10);
  const mtimeSec      = parseInt(parsed.MTIME,       10);
  const nowSec        = parseInt(parsed.NOW,          10);

  // AC5: return verified: false — not throw — on checksum mismatch.
  const verified = Boolean(expectedHash) && expectedHash === actualHash;

  const fileSizeKb = isNaN(fileSizeBytes)
    ? null
    : Math.round(fileSizeBytes / 1024);

  const backupAgeHours = (isNaN(mtimeSec) || isNaN(nowSec))
    ? null
    : Math.round(((nowSec - mtimeSec) / 3600) * 10) / 10;

  return {
    verified,
    backup_path:      parsed.BACKUP_PATH,
    expected_hash:    expectedHash || null,
    actual_hash:      actualHash   || null,
    row_count:        isNaN(rowCount) ? null : rowCount,
    file_size_kb:     fileSizeKb,
    backup_age_hours: backupAgeHours,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
