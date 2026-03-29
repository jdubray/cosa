'use strict';

/**
 * SSH Mock Server
 *
 * Implements a minimal SSH server that intercepts the exact commands COSA's
 * three Phase 1 tools send over SSH, and handles them locally using
 * better-sqlite3 — no sqlite3 binary required.
 *
 * Commands handled:
 *   systemctl show <service> --property=...   → mock systemd properties
 *   sqlite3 -json -readonly "<path>"          → JSON SELECT (db_query)
 *   sqlite3 <path> "PRAGMA integrity_check"   → integrity check (db_integrity)
 *   sqlite3 <path> "PRAGMA wal_checkpoint…"   → WAL checkpoint (db_integrity)
 *   echo <text>                               → echo (setup wizard SSH test)
 */

const { Server } = require('ssh2');
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

          // sqlite3 JSON mode needs stdin (SQL query) before dispatching
          if (command.includes('sqlite3') && command.includes('-json')) {
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
