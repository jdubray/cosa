'use strict';

const { Client } = require('ssh2');
const crypto = require('crypto');
const fs = require('fs');
const { getConfig }    = require('../config/cosa.config');
const { createLogger } = require('./logger');

const log = createLogger('ssh-backend');

// ---------------------------------------------------------------------------
// Backoff constants
// ---------------------------------------------------------------------------

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS  = 30000;

/**
 * Calculate exponential backoff delay for reconnect attempts.
 *
 * Sequence: 1s → 2s → 4s → 8s → 16s → 30s (capped).
 *
 * @param {number} attempt - Zero-based attempt number.
 * @returns {number} Delay in milliseconds.
 */
function backoffMs(attempt) {
  return Math.min(BACKOFF_BASE_MS * (2 ** attempt), BACKOFF_MAX_MS);
}

// ---------------------------------------------------------------------------
// Module-level connection state
// ---------------------------------------------------------------------------

/** @type {import('ssh2').Client | null} */
let _client = null;
let _connected = false;

/** Non-null when a reconnect setTimeout is pending. */
let _reconnectTimer = null;

/** Number of consecutive failed reconnect attempts (reset on success). */
let _reconnectAttempts = 0;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build ssh2 connect options from appliance.yaml.
 *
 * When `ssh.host_key_fingerprint` is set in appliance.yaml the connection is
 * rejected if the server presents a key whose SHA-256 fingerprint does not
 * match, protecting against MITM attacks on the local network.
 *
 * @returns {import('ssh2').ConnectConfig}
 */
function buildSshOptions() {
  const { appliance } = getConfig();
  const ssh = appliance.ssh;

  /** @type {import('ssh2').ConnectConfig} */
  const opts = {
    host:         ssh.host,
    port:         ssh.port         ?? 22,
    username:     ssh.user,
    privateKey:   fs.readFileSync(ssh.key_path),
    readyTimeout: ssh.connect_timeout_ms ?? 5000,
  };

  if (ssh.host_key_fingerprint) {
    const expected = ssh.host_key_fingerprint;
    opts.hostVerifier = (key) => {
      const actual = `SHA256:${crypto.createHash('sha256').update(key).digest('base64')}`;
      if (actual !== expected) {
        log.error(
          `SSH host key mismatch for ${ssh.host} — ` +
          `expected ${expected}, got ${actual}. ` +
          'Connection refused: possible MITM attack.'
        );
        return false;
      }
      return true;
    };
  }

  return opts;
}

/**
 * Open a new SSH connection. Resolves on 'ready', rejects on 'error'.
 * Attaches a 'close' listener that triggers background reconnect on drop.
 *
 * @returns {Promise<void>}
 */
function openConnection() {
  return new Promise((resolve, reject) => {
    const client = new Client();

    client.once('ready', () => {
      _client = client;
      _connected = true;
      _reconnectAttempts = 0;
      resolve();
    });

    client.once('error', (err) => {
      _connected = false;
      client.destroy();
      reject(err);
    });

    // Persistent listener: if the connection drops after 'ready', schedule reconnect.
    client.on('close', () => {
      if (_connected) {
        _connected = false;
        _client = null;
        scheduleReconnect();
      }
    });

    client.connect(buildSshOptions());
  });
}

/**
 * Schedule the next reconnect attempt using exponential backoff.
 * Only one timer is ever active at a time.
 */
function scheduleReconnect() {
  if (_reconnectTimer !== null) return;

  const delay = backoffMs(_reconnectAttempts);
  _reconnectAttempts++;

  _reconnectTimer = setTimeout(async () => {
    _reconnectTimer = null;
    try {
      await openConnection();
      log.info(`Reconnected to ${getConfig().appliance.ssh.host}`);
    } catch (err) {
      log.warn(`Reconnect attempt ${_reconnectAttempts} failed: ${err.message}`);
      scheduleReconnect();
    }
  }, delay);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a shell command on the appliance over SSH.
 *
 * ─── SECURITY CONTRACT ───────────────────────────────────────────────────────
 * `command` MUST be a fixed string literal defined inside a trusted tool
 * implementation (health-check.js, db-query.js, db-integrity.js, etc.).
 *
 * NEVER pass:
 *   • user input
 *   • LLM / Claude output
 *   • any runtime-constructed string derived from external data
 *
 * as the `command` argument. There is no shell escaping or sandboxing here.
 * The command is executed verbatim on the remote host.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * @param {string} command - Fixed shell command from a trusted tool definition.
 * @param {string | null} [stdinData=null] - Optional data written to the
 *   remote process's stdin before EOF.  Use this instead of embedding
 *   dynamic content in the command string to avoid shell injection.
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
 * @throws {Error} if the SSH connection is not established.
 */
function exec(command, stdinData = null) {
  if (!_connected || !_client) {
    return Promise.reject(new Error('SSH not connected — command cannot be executed'));
  }

  const { appliance } = getConfig();
  const timeoutMs = appliance.ssh.command_timeout_ms ?? 30000;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;

    /**
     * Resolve or reject the promise exactly once.
     * @param {{ stdout: string, stderr: string, exitCode: number } | null} value
     * @param {Error | null} err
     */
    function settle(value, err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    }

    _client.exec(command, (err, stream) => {
      if (err) return settle(null, err);

      let stdout = '';
      let stderr = '';

      timer = setTimeout(() => {
        stream.destroy();
        settle(null, new Error(`Command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      stream.on('close', (exitCode) => {
        settle({ stdout, stderr, exitCode: exitCode ?? 1 });
      });

      stream.on('data', (chunk) => { stdout += chunk.toString(); });
      stream.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

      // Write stdin payload (if any) and signal EOF so the remote process
      // receives its input without any shell interpretation.
      if (stdinData !== null) {
        stream.write(stdinData);
        stream.end();
      }
    });
  });
}

/**
 * @returns {boolean} Whether the SSH connection is currently established.
 */
function isConnected() {
  return _connected;
}

/**
 * Connect to the appliance SSH at process startup.
 *
 * If the connection fails, logs a warning and starts background reconnect with
 * exponential backoff. Does NOT throw — the process continues regardless.
 *
 * Logs a security warning when `ssh.host_key_fingerprint` is not configured,
 * because the connection will accept any host key (MITM risk).
 *
 * @returns {Promise<void>}
 */
async function init() {
  const { appliance } = getConfig();
  if (!appliance.ssh.host_key_fingerprint) {
    log.warn(
      'SSH host key verification is DISABLED — ssh.host_key_fingerprint is not set ' +
      'in appliance.yaml. The connection is vulnerable to MITM attacks on the local ' +
      'network. Set host_key_fingerprint to the SHA-256 fingerprint of the appliance ' +
      'host key (see appliance.yaml for instructions).'
    );
  }

  try {
    await openConnection();
    log.info(`Connected to ${appliance.ssh.host}`);
  } catch (err) {
    log.warn(`Initial SSH connection failed: ${err.message}. Retrying in background.`);
    scheduleReconnect();
  }
}

/**
 * Tear down the connection and cancel any pending reconnect timer.
 * For use in graceful shutdown and tests only.
 */
function disconnect() {
  if (_reconnectTimer !== null) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
  _reconnectAttempts = 0;
  _connected = false;
  if (_client !== null) {
    _client.removeAllListeners('close');
    _client.end();
    _client = null;
  }
}

module.exports = { exec, isConnected, init, disconnect, backoffMs };
