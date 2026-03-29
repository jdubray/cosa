'use strict';

const sshBackend = require('../ssh-backend');
const { getConfig } = require('../../config/cosa.config');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME       = 'db_integrity';
const RISK_LEVEL = 'read';

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
    'Run a SQLite integrity check and optional WAL checkpoint on the Baanbaan database ' +
    'via SSH.  Returns is_healthy, the raw integrity_check output, WAL checkpoint ' +
    'statistics, an errors array, and checked_at.',
  inputSchema: INPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the sqlite3 command string for a given PRAGMA expression.
 *
 * @param {string} dbPath   - Absolute path on the Baanbaan Pi.
 * @param {string} pragma   - PRAGMA expression (e.g. "integrity_check").
 * @returns {string}
 */
function buildCommand(dbPath, pragma) {
  return `sqlite3 ${dbPath} "PRAGMA ${pragma}"`;
}

/**
 * Parse `PRAGMA integrity_check` stdout.
 *
 * sqlite3 outputs "ok\n" for a healthy database, or one error description per
 * line for a corrupt one.  We normalise the value by trimming trailing
 * whitespace and using that as the canonical integrity_result string.
 *
 * @param {string} stdout
 * @returns {{ isHealthy: boolean, integrityResult: string }}
 */
function parseIntegrityResult(stdout) {
  const trimmed       = stdout.trim();
  const isHealthy     = trimmed === 'ok';
  return { isHealthy, integrityResult: trimmed };
}

/**
 * Parse `PRAGMA wal_checkpoint(PASSIVE)` stdout.
 *
 * sqlite3 outputs a single pipe-delimited line: `busy|log|checkpointed\n`.
 *
 * @param {string} stdout
 * @returns {{ busy: number, log: number, checkpointed: number }}
 */
function parseCheckpointResult(stdout) {
  const [busyStr, logStr, checkpointedStr] = stdout.trim().split('|');
  return {
    busy:         parseInt(busyStr,         10),
    log:          parseInt(logStr,          10),
    checkpointed: parseInt(checkpointedStr, 10),
  };
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

/**
 * Run an integrity check and optional WAL checkpoint on the Baanbaan SQLite
 * database via SSH.
 *
 * @returns {Promise<{
 *   is_healthy:       boolean,
 *   integrity_result: string,
 *   wal_checkpoint:   { ran: boolean, busy: number|null, log: number|null, checkpointed: number|null },
 *   errors:           string[],
 *   checked_at:       string
 * }>}
 * @throws {Error} if the integrity_check exec fails or sqlite3 exits non-zero.
 */
async function handler() {
  const { appliance } = getConfig();
  const dbPath        = appliance.database.path;
  const runWal        = appliance.tools?.db_integrity?.run_wal_checkpoint ?? false;
  const checkedAt     = new Date().toISOString();
  const errors        = [];

  // ── Step 1: PRAGMA integrity_check ───────────────────────────────────────
  const integrityCmd = buildCommand(dbPath, 'integrity_check');
  const { stdout: integrityStdout, stderr: integrityStderr, exitCode: integrityExit } =
    await sshBackend.exec(integrityCmd);

  if (integrityExit !== 0) {
    throw new Error(
      `sqlite3 exited with code ${integrityExit}: ${integrityStderr.trim()}`
    );
  }

  const { isHealthy, integrityResult } = parseIntegrityResult(integrityStdout);

  if (!isHealthy) {
    errors.push(`integrity_check failed: ${integrityResult}`);
  }

  // ── Step 2: PRAGMA wal_checkpoint(PASSIVE) (optional) ────────────────────
  let walCheckpoint = { ran: false, busy: null, log: null, checkpointed: null };

  if (runWal) {
    try {
      const walCmd = buildCommand(dbPath, 'wal_checkpoint(PASSIVE)');
      const { stdout: walStdout, stderr: walStderr, exitCode: walExit } =
        await sshBackend.exec(walCmd);

      if (walExit !== 0) {
        errors.push(`wal_checkpoint exited with code ${walExit}: ${walStderr.trim()}`);
      } else {
        const { busy, log, checkpointed } = parseCheckpointResult(walStdout);
        walCheckpoint = { ran: true, busy, log, checkpointed };
      }
    } catch (err) {
      errors.push(err.message);
    }
  }

  return {
    is_healthy:       isHealthy,
    integrity_result: integrityResult,
    wal_checkpoint:   walCheckpoint,
    errors,
    checked_at:       checkedAt,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
