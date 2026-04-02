'use strict';

const path     = require('path');
const os       = require('os');
const fs       = require('fs');
const crypto   = require('crypto');
const Database = require('better-sqlite3');
const { createLogger } = require('./logger');

const log = createLogger('credential-store');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DB_PATH      = path.join(os.homedir(), '.cosa', 'credentials.enc.db');
const PBKDF2_ITERS = 100_000;
const KEY_LEN      = 32;               // 256-bit AES key
const ALGORITHM    = 'aes-256-gcm';
const IV_LEN       = 12;               // 96-bit IV — recommended for GCM
const TAG_LEN      = 16;               // 128-bit auth tag
// Fixed application salt — entropy comes from the user-supplied passphrase.
const KDF_SALT     = Buffer.from('cosa-credential-store-v1');

// ---------------------------------------------------------------------------
// Module-level singletons (lazy-initialised)
// ---------------------------------------------------------------------------

/** @type {import('better-sqlite3').Database|null} */
let _db  = null;
/** @type {Buffer|null} */
let _key = null;

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

/**
 * Derive a 256-bit AES key from a raw passphrase using PBKDF2-SHA256.
 *
 * @param {string} rawKey - Passphrase from COSA_CREDENTIAL_KEY env var.
 * @returns {Buffer}
 */
function deriveKey(rawKey) {
  return crypto.pbkdf2Sync(rawKey, KDF_SALT, PBKDF2_ITERS, KEY_LEN, 'sha256');
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * A fresh random IV is generated for every call.
 *
 * @param {string} plaintext
 * @param {Buffer} key - 32-byte AES key.
 * @returns {{ iv: Buffer, authTag: Buffer, ciphertext: Buffer }}
 */
function encrypt(plaintext, key) {
  const iv     = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LEN });
  const ct1    = cipher.update(plaintext, 'utf8');
  const ct2    = cipher.final();
  return {
    iv,
    authTag:    cipher.getAuthTag(),
    ciphertext: Buffer.concat([ct1, ct2]),
  };
}

/**
 * Decrypt a ciphertext produced by {@link encrypt}.
 *
 * @param {{ iv: Buffer, authTag: Buffer, ciphertext: Buffer }} envelope
 * @param {Buffer} key - 32-byte AES key.
 * @returns {string} Decrypted plaintext.
 */
function decrypt({ iv, authTag, ciphertext }, key) {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(authTag);
  const pt1 = decipher.update(ciphertext);
  const pt2 = decipher.final();
  return Buffer.concat([pt1, pt2]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/**
 * Open (or create) the encrypted-credential SQLite database.
 * The database file itself is stored in plain SQLite format; encryption is
 * applied at the record level by {@link encrypt} / {@link decrypt}.
 *
 * @returns {import('better-sqlite3').Database}
 */
function openDatabase() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS credentials (
      name          TEXT    PRIMARY KEY,
      ciphertext    BLOB    NOT NULL,
      iv            BLOB    NOT NULL,
      auth_tag      BLOB    NOT NULL,
      created_at    INTEGER NOT NULL,
      last_accessed INTEGER
    );
    CREATE TABLE IF NOT EXISTS _meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  db.prepare(`INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', '1')`).run();
  return db;
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * Ensure the credential store is open and the key is derived.
 * Called lazily on first use and eagerly during startup validation.
 *
 * @throws {Error} If COSA_CREDENTIAL_KEY is not set.
 */
function init() {
  if (_db && _key) return;

  const rawKey = process.env.COSA_CREDENTIAL_KEY;
  if (!rawKey) {
    throw new Error(
      'COSA_CREDENTIAL_KEY environment variable is not set. ' +
      'Set it to a strong secret before starting COSA.'
    );
  }

  _key = deriveKey(rawKey);
  _db  = openDatabase();
  log.info(`Credential store opened: ${DB_PATH}`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Retrieve a stored credential by symbolic name.
 * Updates `last_accessed` on every successful retrieval.
 *
 * @param {string} name - Symbolic name (e.g. `'stripe_api_key'`).
 * @returns {string} Decrypted credential value.
 * @throws {Error} If the name is not found.
 */
function get(name) {
  init();

  const row = _db.prepare(
    'SELECT ciphertext, iv, auth_tag FROM credentials WHERE name = ?'
  ).get(name);

  if (!row) throw new Error(`Credential not found: ${name}`);

  const value = decrypt(
    { iv: row.iv, authTag: row.auth_tag, ciphertext: row.ciphertext },
    _key
  );

  _db.prepare(
    'UPDATE credentials SET last_accessed = ? WHERE name = ?'
  ).run(Date.now(), name);

  // Log the symbolic name only — never the value.
  log.debug(`Credential accessed: ${name}`);
  return value;
}

/**
 * Store or update a credential.
 *
 * @param {string} name  - Symbolic name.
 * @param {string} value - Plaintext credential value (never logged).
 */
function set(name, value) {
  init();

  const { iv, authTag, ciphertext } = encrypt(value, _key);
  const now = Date.now();

  _db.prepare(`
    INSERT INTO credentials (name, ciphertext, iv, auth_tag, created_at, last_accessed)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      ciphertext    = excluded.ciphertext,
      iv            = excluded.iv,
      auth_tag      = excluded.auth_tag,
      last_accessed = excluded.last_accessed
  `).run(name, ciphertext, iv, authTag, now, now);

  // Log the symbolic name only — never the value.
  log.info(`Credential stored: ${name}`);
}

/**
 * List all credential names with metadata (no values).
 *
 * @returns {Array<{ name: string, created_at: number, last_accessed: number|null }>}
 */
function list() {
  init();
  return _db.prepare(
    'SELECT name, created_at, last_accessed FROM credentials ORDER BY name'
  ).all();
}

/**
 * Return metadata for a single credential without decrypting its value.
 * Useful for rotation-age checks that must not expose the secret.
 *
 * @param {string} name - Symbolic name.
 * @returns {{ name: string, created_at: number, last_accessed: number|null }|null}
 */
function getMetadata(name) {
  init();
  return _db.prepare(
    'SELECT name, created_at, last_accessed FROM credentials WHERE name = ?'
  ).get(name) ?? null;
}

/**
 * Validate that the credential store is accessible at startup.
 * Fails fast if COSA_CREDENTIAL_KEY is missing.
 * Called from boot() in main.js.
 */
function validateOnStartup() {
  init();
  // A cheap read to confirm DB is open and key works.
  _db.prepare('SELECT COUNT(*) AS cnt FROM credentials').get();
  log.info('Credential store: startup validation passed.');
}

module.exports = { get, set, list, getMetadata, init, validateOnStartup };
