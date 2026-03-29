'use strict';

/**
 * HTTP server implementing two groups of endpoints:
 *
 *   Health (COSA Phase 1 tools):
 *     GET /health        — liveness check with uptime and latest reading
 *     GET /health/ready  — readiness check
 *
 *   Setup API (COSA setup wizard + Baanbaan spec):
 *     GET  /setup/info              — appliance metadata + SSH fingerprint
 *     POST /setup/register-ssh-key  — register COSA public key via PIN
 *     GET  /setup/status            — setup mode and registration state
 */

const express = require('express');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const { createLogger } = require('./logger');
const db = require('./database');

const log      = createLogger('server');
const DATA_DIR = path.join(__dirname, '..', 'data');

const app = express();
app.use(express.json());

/** Timestamp of process start, set when start() is called. */
let _startedAt = Date.now();
/** Loaded station.yaml config, set when start() is called. */
let _config    = null;

// ---------------------------------------------------------------------------
// Health endpoints
// ---------------------------------------------------------------------------

app.get('/health', (req, res) => {
  const latest = db.getLatestReading();
  res.json({
    status:          'ok',
    uptime_seconds:  Math.floor((Date.now() - _startedAt) / 1000),
    version:         _config.station.version,
    latest_reading:  latest ? latest.recorded_at : null,
  });
});

app.get('/health/ready', (req, res) => {
  res.json({ ready: true });
});

// ---------------------------------------------------------------------------
// Setup API — GET /setup/info
// ---------------------------------------------------------------------------

app.get('/setup/info', (req, res) => {
  const registeredPath = path.join(DATA_DIR, 'cosa_registered');
  const pinFile        = path.join(DATA_DIR, 'setup_pin.json');

  let pinExpiresAt = null;
  if (fs.existsSync(pinFile)) {
    try {
      pinExpiresAt = JSON.parse(fs.readFileSync(pinFile, 'utf8')).expires_at;
    } catch { /* leave null */ }
  }

  const pubKeyPath = path.join(DATA_DIR, 'host_key.pub');
  const fingerprint = fs.existsSync(pubKeyPath) ? computeFingerprint(pubKeyPath) : null;

  res.json({
    appliance: {
      name:        _config.station.name,
      version:     _config.station.version,
      runtime:     `Node.js ${process.version}`,
      os:          `${process.platform} (dev mock)`,
      deploy_path: path.resolve(path.join(__dirname, '..')),
      api_port:    _config.http.port,
      timezone:    _config.station.timezone,
      pos_adapter: 'Open-Meteo weather API',
    },
    network: {
      lan_ip:         '127.0.0.1',
      mdns_hostname:  'weather-station.local',
    },
    ssh: {
      port:                 _config.ssh.port,
      user:                 _config.ssh.user,
      host_key_fingerprint: fingerprint,
    },
    database: {
      path: db.getDbPath(),
    },
    process_supervisor: {
      type:         'systemd',
      service_name: 'weather-station',
    },
    setup: {
      cosa_registered: fs.existsSync(registeredPath),
      pin_expires_at:  pinExpiresAt,
    },
  });
});

// ---------------------------------------------------------------------------
// Setup API — POST /setup/register-ssh-key
// ---------------------------------------------------------------------------

app.post('/setup/register-ssh-key', (req, res) => {
  const { public_key, pin } = req.body ?? {};

  if (!public_key || !pin) {
    return res.status(400).json({
      error:   'invalid_request',
      message: 'Missing public_key or pin.',
    });
  }

  const registeredPath = path.join(DATA_DIR, 'cosa_registered');
  if (fs.existsSync(registeredPath)) {
    return res.status(409).json({
      error:   'already_registered',
      message: 'A COSA key is already registered. Run `npm run reset` to start over.',
    });
  }

  const pinFile = path.join(DATA_DIR, 'setup_pin.json');
  if (!fs.existsSync(pinFile)) {
    return res.status(503).json({
      error:   'setup_inactive',
      message: 'No setup PIN has been generated. Start the weather station to get a PIN.',
    });
  }

  let pinData;
  try {
    pinData = JSON.parse(fs.readFileSync(pinFile, 'utf8'));
  } catch {
    return res.status(503).json({
      error:   'setup_inactive',
      message: 'PIN data unreadable — restart the weather station.',
    });
  }

  if (pinData.used) {
    return res.status(410).json({
      error:   'pin_expired',
      message: 'This PIN has already been used. Run `npm run reset && npm start` to generate a new one.',
    });
  }

  if (new Date() > new Date(pinData.expires_at)) {
    return res.status(410).json({
      error:   'pin_expired',
      message: 'Setup PIN expired. Restart the weather station to generate a new one.',
    });
  }

  if (pin !== pinData.pin) {
    return res.status(401).json({
      error:   'incorrect_pin',
      message: 'Incorrect PIN.',
    });
  }

  // Append the COSA public key to authorized_keys
  const authKeysPath = path.join(DATA_DIR, 'authorized_keys');
  fs.appendFileSync(authKeysPath, public_key.trim() + '\n');

  // Invalidate PIN (single-use)
  pinData.used = true;
  fs.writeFileSync(pinFile, JSON.stringify(pinData));

  // Write registration flag
  fs.writeFileSync(registeredPath, new Date().toISOString());

  log.info('COSA SSH key registered');
  res.json({ ok: true, message: 'COSA registered successfully.' });
});

// ---------------------------------------------------------------------------
// Setup API — GET /setup/status
// ---------------------------------------------------------------------------

app.get('/setup/status', (req, res) => {
  const registered = fs.existsSync(path.join(DATA_DIR, 'cosa_registered'));
  const pinFile    = path.join(DATA_DIR, 'setup_pin.json');

  let setupModeActive = false;
  if (fs.existsSync(pinFile)) {
    try {
      const p = JSON.parse(fs.readFileSync(pinFile, 'utf8'));
      setupModeActive = !p.used && new Date() < new Date(p.expires_at);
    } catch { /* leave false */ }
  }

  res.json({ ok: true, cosa_registered: registered, setup_mode_active: setupModeActive });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the SSH host key fingerprint from a .pub file.
 *
 * The OpenSSH .pub format is: "ssh-ed25519 <base64> [comment]"
 * The base64 value is the raw wire-format public key bytes.
 * SHA-256 of those bytes (base64-encoded) is the fingerprint — identical to
 * what COSA's hostVerifier computes from the ssh2 key buffer.
 *
 * @param {string} pubKeyPath
 * @returns {string} e.g. "SHA256:AbCdEf..."
 */
function computeFingerprint(pubKeyPath) {
  const line     = fs.readFileSync(pubKeyPath, 'utf8').trim();
  const b64      = line.split(/\s+/)[1];
  const keyBytes = Buffer.from(b64, 'base64');
  const hash     = crypto.createHash('sha256').update(keyBytes).digest('base64');
  return `SHA256:${hash}`;
}

/**
 * Start the HTTP server.
 *
 * @param {object} config - Parsed station.yaml config.
 */
function start(config) {
  _config    = config;
  _startedAt = Date.now();

  const { port, host } = config.http;
  app.listen(port, host, () => {
    log.info(`HTTP server listening on ${host}:${port}`);
  });
}

module.exports = { start, computeFingerprint };
