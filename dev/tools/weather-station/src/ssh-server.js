'use strict';

/**
 * SSH Mock Server
 *
 * Implements a minimal SSH server that intercepts the exact commands COSA's
 * tools send over SSH, and handles them locally using better-sqlite3 — no
 * sqlite3 binary required.
 *
 * Commands handled:
 *   systemctl show <service> --property=...   → mock systemd properties
 *   sqlite3 -json -readonly "<path>"          → JSON SELECT (db_query)
 *   sqlite3 <path> "PRAGMA integrity_check"   → integrity check (db_integrity)
 *   sqlite3 <path> "PRAGMA wal_checkpoint…"   → WAL checkpoint (db_integrity)
 *   echo <text>                               → echo (setup wizard SSH test)
 *   bash -s (backup_run script)               → Node.js export via better-sqlite3 + crypto
 *   bash -s (backup_verify script)           → Node.js verify via crypto + fs
 */

const { Server } = require('ssh2');
const { spawn }  = require('child_process');
const crypto     = require('crypto');
const Database   = require('better-sqlite3');
const fs         = require('fs');
const path       = require('path');
const { createLogger } = require('./logger');

const log      = createLogger('ssh-server');
const DATA_DIR = path.join(__dirname, '..', 'data');

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

/**
 * Check whether the given wire-format public key buffer appears in
 * data/authorized_keys (same format as OpenSSH authorized_keys).
 *
 * @param {Buffer} keyData - Raw SSH wire-format public key bytes.
 * @returns {boolean}
 */
function isKeyAuthorized(keyData) {
  const authKeysPath = path.join(DATA_DIR, 'authorized_keys');
  if (!fs.existsSync(authKeysPath)) return false;

  for (const line of fs.readFileSync(authKeysPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;

    try {
      const stored = Buffer.from(parts[1], 'base64');
      if (keyData.equals(stored)) return true;
    } catch { /* skip malformed line */ }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

/**
 * Respond to `systemctl show <service> --property=...` with mock systemd output.
 * COSA health_check expects: ActiveState, SubState, ExecMainStartTimestamp, NRestarts
 *
 * @param {import('ssh2').ServerChannel} stream
 * @param {string} startedAt - ISO 8601 timestamp of process start.
 */
function handleSystemctl(stream, startedAt) {
  const d    = new Date(startedAt);
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const p    = (n) => String(n).padStart(2, '0');
  const ts   = `${DAYS[d.getUTCDay()]} ` +
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;

  stream.write(`ActiveState=active\nSubState=running\nExecMainStartTimestamp=${ts}\nNRestarts=0\n`);
  stream.exit(0);
  stream.close();
}

/**
 * Execute a read-only JSON SELECT query (db_query tool).
 * COSA sends: sqlite3 -json -readonly "<dbPath>"   with SQL via stdin.
 * Returns a JSON array of row objects, or empty string for no rows.
 *
 * @param {import('ssh2').ServerChannel} stream
 * @param {string} dbPath
 * @param {string} sql - SQL received from stdin.
 */
function handleSqliteJson(stream, dbPath, sql) {
  try {
    const db   = new Database(dbPath, { readonly: true });
    try {
      const rows = db.prepare(sql.trim()).all();
      stream.write(rows.length > 0 ? JSON.stringify(rows) + '\n' : '');
      stream.exit(0);
    } finally {
      db.close();
    }
  } catch (err) {
    stream.stderr.write(err.message + '\n');
    stream.exit(1);
  }
  stream.close();
}

/**
 * Run PRAGMA integrity_check (db_integrity tool).
 * COSA sends: sqlite3 <dbPath> "PRAGMA integrity_check"
 * Returns "ok" for a healthy database.
 *
 * @param {import('ssh2').ServerChannel} stream
 * @param {string} dbPath
 */
function handleIntegrityCheck(stream, dbPath) {
  try {
    const db = new Database(dbPath);
    try {
      const result = db.pragma('integrity_check', { simple: true });
      stream.write(result + '\n');
      stream.exit(0);
    } finally {
      db.close();
    }
  } catch (err) {
    stream.stderr.write(err.message + '\n');
    stream.exit(1);
  }
  stream.close();
}

/**
 * Run PRAGMA wal_checkpoint(PASSIVE) (db_integrity tool).
 * COSA sends: sqlite3 <dbPath> "PRAGMA wal_checkpoint(PASSIVE)"
 * Returns pipe-delimited: busy|log|checkpointed
 *
 * @param {import('ssh2').ServerChannel} stream
 * @param {string} dbPath
 */
function handleWalCheckpoint(stream, dbPath) {
  try {
    const db = new Database(dbPath);
    try {
      const [res] = db.pragma('wal_checkpoint(PASSIVE)');
      stream.write(`${res.busy}|${res.log}|${res.checkpointed}\n`);
      stream.exit(0);
    } finally {
      db.close();
    }
  } catch (err) {
    stream.stderr.write(err.message + '\n');
    stream.exit(1);
  }
  stream.close();
}

/**
 * Handle a backup_run piped script entirely in Node.js.
 *
 * The backup_run tool sends a bash script that:
 *   1. Creates the backup directory.
 *   2. Exports the readings table as JSONL using sqlite3 CLI + node transformer.
 *   3. Checksums the file with sha256sum.
 *   4. Writes a .sha256 sidecar.
 *   5. Prints ROW_COUNT and CHECKSUM on stdout.
 *
 * We replicate steps 1-5 using better-sqlite3 + crypto so the mock does not
 * require sqlite3 CLI to be installed on the host system.
 *
 * @param {import('ssh2').ServerChannel} stream
 * @param {string} script - The backup_run bash script.
 */
function handleBackupRun(stream, script) {
  try {
    const dbMatch     = script.match(/sqlite3 -json '([^']+)'/);
    const backupMatch = script.match(/> '([^']+\.jsonl)'/);
    const sidecarMatch = script.match(/> '([^']+\.sha256)'/);

    if (!dbMatch || !backupMatch) {
      stream.stderr.write('mock-ssh: could not parse backup_run script\n');
      stream.exit(1);
      stream.close();
      return;
    }

    const dbPath      = dbMatch[1];
    const backupPath  = backupMatch[1];
    const sidecarPath = sidecarMatch ? sidecarMatch[1] : `${backupPath}.sha256`;
    const backupFile  = path.basename(backupPath);
    const backupDir   = path.dirname(backupPath);

    fs.mkdirSync(backupDir, { recursive: true });

    const db   = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT * FROM readings').all();
    db.close();

    // Build JSONL — one JSON object per line, trailing newline when non-empty.
    const jsonl   = rows.length > 0 ? rows.map(r => JSON.stringify(r)).join('\n') + '\n' : '';
    const content = Buffer.from(jsonl, 'utf8');

    fs.writeFileSync(backupPath, content);

    const checksum = crypto.createHash('sha256').update(content).digest('hex');

    // Sidecar format mirrors sha256sum output: "<hash>  <filename>"
    fs.writeFileSync(sidecarPath, `${checksum}  ${backupFile}\n`, 'utf8');

    stream.write(`${rows.length}\n${checksum}\n`);
    stream.exit(0);
  } catch (err) {
    stream.stderr.write(err.message + '\n');
    stream.exit(1);
  }
  stream.close();
}

/**
 * Handle a backup_verify piped script entirely in Node.js.
 *
 * The backup_verify tool sends a bash script that:
 *   1. Locates the target .jsonl file (explicit path or most-recent glob).
 *   2. Reads the expected hash from the .sha256 sidecar.
 *   3. Recomputes the actual SHA-256 hash.
 *   4. Collects row_count, file_size, mtime, and now.
 *   5. Prints KEY=VALUE pairs on stdout.
 *   6. Prints NO_BACKUP_FOUND and exits 0 when no file is available.
 *
 * @param {import('ssh2').ServerChannel} stream
 * @param {string} script - The backup_verify bash script.
 */
function handleBackupVerify(stream, script) {
  try {
    // Determine target backup path — explicit override or auto-detect.
    let backupPath;

    const overrideMatch = script.match(/^BACKUP_PATH='([^']+)'/m);
    if (overrideMatch) {
      backupPath = overrideMatch[1];
    } else {
      const dirMatch = script.match(/ls '([^']+)'\/readings_\*\.jsonl/);
      if (!dirMatch) {
        stream.write('NO_BACKUP_FOUND\n');
        stream.exit(0);
        stream.close();
        return;
      }
      const backupDir = dirMatch[1];
      let files = [];
      try {
        files = fs.readdirSync(backupDir)
          .filter(f => f.startsWith('readings_') && f.endsWith('.jsonl'))
          .map(f => path.join(backupDir, f))
          .sort()
          .reverse();
      } catch { /* dir doesn't exist */ }

      if (files.length === 0) {
        stream.write('NO_BACKUP_FOUND\n');
        stream.exit(0);
        stream.close();
        return;
      }
      backupPath = files[0];
    }

    if (!fs.existsSync(backupPath)) {
      stream.write('NO_BACKUP_FOUND\n');
      stream.exit(0);
      stream.close();
      return;
    }

    const sidecarPath = `${backupPath}.sha256`;
    let expected = '';
    if (fs.existsSync(sidecarPath)) {
      const sidecarContent = fs.readFileSync(sidecarPath, 'utf8');
      expected = sidecarContent.trim().split(/\s+/)[0] ?? '';
    }

    const content  = fs.readFileSync(backupPath);
    const actual   = crypto.createHash('sha256').update(content).digest('hex');
    const rowCount = content.toString('utf8').split('\n').filter(l => l.trim()).length;
    const stat     = fs.statSync(backupPath);
    const mtime    = Math.floor(stat.mtimeMs / 1000);
    const now      = Math.floor(Date.now() / 1000);

    stream.write([
      `BACKUP_PATH=${backupPath}`,
      `EXPECTED=${expected}`,
      `ACTUAL=${actual}`,
      `ROW_COUNT=${rowCount}`,
      `FILE_SIZE=${stat.size}`,
      `MTIME=${mtime}`,
      `NOW=${now}`,
      '',
    ].join('\n'));
    stream.exit(0);
  } catch (err) {
    stream.stderr.write(err.message + '\n');
    stream.exit(1);
  }
  stream.close();
}

/**
 * Execute a bash script piped via stdin.
 * Dispatches to Node.js handlers for backup_run and backup_verify so the mock
 * does not require sqlite3, sha256sum, or stat to be installed on the host.
 * Falls back to spawning bash for any unrecognised script.
 *
 * @param {import('ssh2').ServerChannel} stream
 * @param {string} script - The bash script received on stdin.
 */
function handleBashScript(stream, script) {
  // backup_run script contains 'sqlite3 -json' (and not 'NO_BACKUP_FOUND').
  if (script.includes('sqlite3 -json') && !script.includes('NO_BACKUP_FOUND')) {
    handleBackupRun(stream, script);
    return;
  }

  // backup_verify script always contains 'NO_BACKUP_FOUND'.
  if (script.includes('NO_BACKUP_FOUND')) {
    handleBackupVerify(stream, script);
    return;
  }

  // Unrecognised script — fall back to spawning bash.
  const child = spawn('bash', ['-s']);

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  child.on('close', (code) => {
    if (stdout) stream.write(stdout);
    if (stderr) stream.stderr.write(stderr);
    stream.exit(code ?? 1);
    stream.close();
  });

  child.on('error', (err) => {
    stream.stderr.write(`bash spawn error: ${err.message}\n`);
    stream.exit(127);
    stream.close();
  });

  child.stdin.write(script);
  child.stdin.end();
}

/**
 * Route an incoming exec command to the appropriate handler.
 *
 * @param {import('ssh2').ServerChannel} stream
 * @param {string} command
 * @param {string} stdinData - Collected stdin (may be empty string).
 * @param {string} startedAt - Process start ISO timestamp.
 * @param {string} dbPath    - Absolute path to the SQLite database.
 */
function dispatch(stream, command, stdinData, startedAt, dbPath) {
  log.debug(`SSH exec: ${command}`);

  // systemctl show (health_check tool — step 4)
  if (command.includes('systemctl') && command.includes('show')) {
    handleSystemctl(stream, startedAt);
    return;
  }

  // sqlite3 JSON query (db_query tool)
  if (command.includes('sqlite3') && command.includes('-json')) {
    handleSqliteJson(stream, dbPath, stdinData);
    return;
  }

  // sqlite3 PRAGMA integrity_check (db_integrity tool)
  if (command.includes('sqlite3') && command.includes('integrity_check')) {
    handleIntegrityCheck(stream, dbPath);
    return;
  }

  // sqlite3 PRAGMA wal_checkpoint (db_integrity tool)
  if (command.includes('sqlite3') && command.includes('wal_checkpoint')) {
    handleWalCheckpoint(stream, dbPath);
    return;
  }

  // echo (COSA setup wizard SSH connectivity test)
  if (/^echo\s/.test(command)) {
    stream.write(command.replace(/^echo\s+/, '') + '\n');
    stream.exit(0);
    stream.close();
    return;
  }

  // bash -s (backup_run, backup_verify — script piped via stdin)
  if (command === 'bash -s') {
    handleBashScript(stream, stdinData);
    return;
  }

  // Unhandled — return a clear error so callers know what to add
  log.warn(`SSH: unhandled command: ${command}`);
  stream.stderr.write(`mock-ssh: command not implemented: ${command}\n`);
  stream.exit(127);
  stream.close();
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

/**
 * Start the SSH mock server.
 *
 * @param {object} config    - Parsed station.yaml config.
 * @param {string} startedAt - ISO timestamp of process startup (for uptime calc).
 * @param {string} dbPath    - Absolute path to the SQLite database.
 */
function start(config, startedAt, dbPath) {
  const hostKeyPath = path.join(DATA_DIR, 'host_key');
  const hostKey     = fs.readFileSync(hostKeyPath);

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    log.debug('SSH: incoming connection');

    client.on('authentication', (ctx) => {
      if (ctx.method !== 'publickey') {
        return ctx.reject(['publickey']);
      }
      if (!isKeyAuthorized(ctx.key.data)) {
        log.warn('SSH: rejected key — not in authorized_keys');
        return ctx.reject(['publickey']);
      }
      ctx.accept();
    });

    client.on('ready', () => {
      log.info('SSH: client authenticated');

      client.on('session', (accept) => {
        const session = accept();

        session.on('exec', (accept, reject, info) => {
          const stream  = accept();
          const command = info.command;

          // Commands that need stdin collected before dispatching.
          if (
            (command.includes('sqlite3') && command.includes('-json')) ||
            command === 'bash -s'
          ) {
            let stdinData = '';
            stream.on('data', (chunk) => { stdinData += chunk.toString(); });
            stream.on('end', () => dispatch(stream, command, stdinData, startedAt, dbPath));
            return;
          }

          // All other commands: respond without waiting for stdin
          dispatch(stream, command, '', startedAt, dbPath);
        });
      });
    });

    client.on('error', (err) => log.debug(`SSH client error: ${err.message}`));
    client.on('end',   () => log.debug('SSH: connection closed'));
  });

  const { port, host } = config.ssh;

  server.listen(port, host, () => {
    log.info(`SSH server listening on ${host}:${port}`);
  });

  server.on('error', (err) => log.error(`SSH server error: ${err.message}`));
}

module.exports = { start };
