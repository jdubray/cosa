'use strict';

/**
 * Weather Station Mock — entry point.
 *
 * Startup sequence:
 *   1. Load config/station.yaml
 *   2. Create data/ directory
 *   3. Generate SSH host key (first run only)
 *   4. Generate setup PIN (if not already registered)
 *   5. Initialize SQLite database
 *   6. Start HTTP server (port 3000)
 *   7. Start SSH mock server (port 2222)
 *   8. Start weather fetcher (immediate + hourly)
 *   9. Print COSA appliance.yaml snippet
 */

const fs          = require('fs');
const path        = require('path');
const crypto      = require('crypto');
const { execSync } = require('child_process');
const yaml        = require('js-yaml');

const { createLogger }  = require('./logger');
const db                = require('./database');
const httpServer        = require('./server');
const sshServer         = require('./ssh-server');
const weatherFetcher    = require('./weather-fetcher');

const log = createLogger('main');

const ROOT_DIR    = path.join(__dirname, '..');
const DATA_DIR    = path.join(ROOT_DIR, 'data');
const CONFIG_PATH = path.join(ROOT_DIR, 'config', 'station.yaml');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadConfig() {
  return yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// ---------------------------------------------------------------------------
// SSH host key
// ---------------------------------------------------------------------------

/**
 * Generate a new ED25519 host key pair if one does not already exist.
 * Requires `ssh-keygen` (included with OpenSSH on macOS, Linux, Windows 10+).
 *
 * @returns {string} Path to the private key file.
 */
function ensureHostKey() {
  const keyPath = path.join(DATA_DIR, 'host_key');
  if (!fs.existsSync(keyPath)) {
    log.info('Generating SSH host key (first run)...');
    execSync(
      `ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`,
      { stdio: 'pipe' },
    );
    log.info('Host key generated');
  }
  return keyPath;
}

/**
 * Compute the SHA-256 SSH fingerprint from a .pub file.
 * Matches the formula COSA's hostVerifier uses.
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

// ---------------------------------------------------------------------------
// Setup PIN
// ---------------------------------------------------------------------------

/**
 * Generate and display a setup PIN if COSA has not yet been registered.
 * If a valid unexpired PIN already exists, reuses it (idempotent).
 *
 * @returns {string|null} The active PIN, or null if already registered.
 */
function ensureSetupPin() {
  const registeredPath = path.join(DATA_DIR, 'cosa_registered');

  if (fs.existsSync(registeredPath)) {
    log.info('COSA is already registered — setup PIN not needed');
    return null;
  }

  const pinFile = path.join(DATA_DIR, 'setup_pin.json');

  // Reuse existing valid PIN
  if (fs.existsSync(pinFile)) {
    try {
      const existing = JSON.parse(fs.readFileSync(pinFile, 'utf8'));
      if (!existing.used && new Date() < new Date(existing.expires_at)) {
        return existing.pin;
      }
    } catch { /* regenerate below */ }
  }

  // Generate new PIN
  const pin        = String(crypto.randomInt(100000, 999999));
  const expiresAt  = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  fs.writeFileSync(pinFile, JSON.stringify({ pin, expires_at: expiresAt, used: false }));
  return pin;
}

// ---------------------------------------------------------------------------
// Startup banner helpers
// ---------------------------------------------------------------------------

const CYAN  = '\x1b[36m';
const GREEN = '\x1b[32m';
const BOLD  = '\x1b[1m';
const DIM   = '\x1b[2m';
const RST   = '\x1b[0m';

function banner(lines) {
  const width = Math.max(...lines.map(l => l.length)) + 4;
  const hr    = '─'.repeat(width);
  process.stdout.write(`\n${CYAN}┌${hr}┐${RST}\n`);
  for (const l of lines) {
    const pad = ' '.repeat(width - l.length - 2);
    process.stdout.write(`${CYAN}│${RST}  ${l}${pad}  ${CYAN}│${RST}\n`);
  }
  process.stdout.write(`${CYAN}└${hr}┘${RST}\n\n`);
}

function printPinBanner(pin, expiresAt) {
  banner([
    `${BOLD}COSA Setup PIN: ${GREEN}${pin}${RST}`,
    `${DIM}Expires: ${new Date(expiresAt).toISOString().slice(0, 16)} UTC${RST}`,
    '',
    'Run the COSA setup wizard to connect:',
    `  cd <cosa-directory>`,
    `  npm run setup`,
    '',
    'When asked for Baanbaan IP, enter: 127.0.0.1',
    'When asked for the setup PIN, enter the code above.',
  ]);
}

function printCosaConfig(config, fingerprint) {
  const dbPath = db.getDbPath().replace(/\\/g, '/');

  process.stdout.write(`${BOLD}COSA appliance.yaml snippet (after running setup, update port):${RST}\n\n`);
  process.stdout.write(`${DIM}─────────────────────────────────────────────────────────────${RST}\n`);
  process.stdout.write(`${CYAN}ssh:${RST}\n`);
  process.stdout.write(`  host: "127.0.0.1"\n`);
  process.stdout.write(`  ${BOLD}port: ${config.ssh.port}${RST}          ${DIM}# ← must set this manually after npm run setup${RST}\n`);
  process.stdout.write(`  user: "${config.ssh.user}"\n`);
  process.stdout.write(`  key_path: "~/.ssh/id_ed25519_cosa"\n`);
  process.stdout.write(`  host_key_fingerprint: "${fingerprint}"\n`);
  process.stdout.write(`${CYAN}appliance_api:${RST}\n`);
  process.stdout.write(`  base_url: "http://127.0.0.1:${config.http.port}"\n`);
  process.stdout.write(`  health_endpoint: "/health"\n`);
  process.stdout.write(`  health_ready_endpoint: "/health/ready"\n`);
  process.stdout.write(`${CYAN}database:${RST}\n`);
  process.stdout.write(`  path: "${dbPath}"\n`);
  process.stdout.write(`${DIM}─────────────────────────────────────────────────────────────${RST}\n\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const startedAt = new Date().toISOString();

  process.stdout.write(`\n${BOLD}${CYAN}╔══════════════════════════════════════╗${RST}\n`);
  process.stdout.write(`${BOLD}${CYAN}║  COSA Weather Station Mock  v1.0.0   ║${RST}\n`);
  process.stdout.write(`${BOLD}${CYAN}╚══════════════════════════════════════╝${RST}\n\n`);

  // 1. Load config
  const config = loadConfig();
  log.info(`Station: ${config.station.name} — ${config.weather.location_name}`);

  // 2. Create data directory
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // 3. SSH host key
  const keyPath     = ensureHostKey();
  const fingerprint = computeFingerprint(keyPath + '.pub');

  // 4. Setup PIN
  const pin = ensureSetupPin();

  // 5. Database
  db.init();

  // 6. HTTP server
  httpServer.start(config);

  // 7. SSH server
  sshServer.start(config, startedAt, db.getDbPath());

  // 8. Weather fetcher
  weatherFetcher.start(config);

  // 9. Banner output
  log.info(`SSH host key fingerprint: ${fingerprint}`);

  if (pin) {
    // Read the stored expiry for display
    let expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    try {
      const pinFile = path.join(DATA_DIR, 'setup_pin.json');
      expiresAt = JSON.parse(fs.readFileSync(pinFile, 'utf8')).expires_at;
    } catch { /* use default */ }

    printPinBanner(pin, expiresAt);
  }

  printCosaConfig(config, fingerprint);

  log.info('Weather station ready.');
}

main().catch(err => {
  // createLogger may not be set up yet — use raw stderr
  process.stderr.write(`[main] Fatal: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
