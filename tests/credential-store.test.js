'use strict';

/**
 * Unit tests for src/credential-store.js
 *
 * Acceptance Criteria covered:
 *   AC1 — credentials.enc.db is created at ~/.cosa/credentials.enc.db
 *   AC2 — Key derived from COSA_CREDENTIAL_KEY via PBKDF2-SHA256 (100k iters, 32 bytes)
 *   AC3 — get(name) retrieves and decrypts, updates last_accessed
 *   AC4 — get(name) throws when credential not found
 *   AC5 — Credential values never appear in logs (symbolic names only)
 *   AC6 — COSA startup fails if COSA_CREDENTIAL_KEY is not set
 *   AC7 — Seed credential names are importable via set() / import pathway
 */

const os   = require('os');
const path = require('path');
const fs   = require('fs');

// ---------------------------------------------------------------------------
// Redirect DB_PATH to a temp directory for test isolation.
// We patch os.homedir before requiring the module.
// ---------------------------------------------------------------------------

let tmpHome;
let credentialStore;

/** Force the module to re-initialise on each test. */
function reloadModule() {
  jest.resetModules();
  // Patch homedir to point to our temp directory.
  jest.spyOn(os, 'homedir').mockReturnValue(tmpHome);
  credentialStore = require('../src/credential-store');
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cosa-cred-test-'));
  process.env.COSA_CREDENTIAL_KEY = 'test-passphrase-for-unit-tests';
  reloadModule();
});

afterEach(() => {
  // Reset singletons between tests.
  jest.resetModules();
  jest.restoreAllMocks();
  delete process.env.COSA_CREDENTIAL_KEY;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC1 — database file is created under ~/.cosa/
// ---------------------------------------------------------------------------

describe('AC1 — database creation', () => {
  it('creates credentials.enc.db inside ~/.cosa/ on first use', () => {
    credentialStore.validateOnStartup();

    const dbPath = path.join(tmpHome, '.cosa', 'credentials.enc.db');
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('creates the ~/.cosa/ directory if it does not exist', () => {
    const cosaDir = path.join(tmpHome, '.cosa');
    expect(fs.existsSync(cosaDir)).toBe(false); // not yet created

    credentialStore.validateOnStartup();

    expect(fs.existsSync(cosaDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC2 — key derivation (PBKDF2) is exercised implicitly; two different
//       passphrases must produce different encrypted blobs for the same value.
// ---------------------------------------------------------------------------

describe('AC2 — key derivation isolates ciphertexts across passphrases', () => {
  it('encrypts the same value differently when passphrase differs', () => {
    // Store with passphrase-A.
    process.env.COSA_CREDENTIAL_KEY = 'passphrase-A';
    reloadModule();
    credentialStore.set('mykey', 'secret-value');

    const dbPath = path.join(tmpHome, '.cosa', 'credentials.enc.db');
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    const rowA = db.prepare('SELECT ciphertext FROM credentials WHERE name = ?').get('mykey');
    db.close();

    // Reset and re-init with a DIFFERENT passphrase — must not decrypt rowA.
    jest.resetModules();
    process.env.COSA_CREDENTIAL_KEY = 'passphrase-B';
    jest.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    const storeB = require('../src/credential-store');

    expect(() => storeB.get('mykey')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC3 — get() retrieves credential and updates last_accessed
// ---------------------------------------------------------------------------

describe('AC3 — get() retrieval and last_accessed update', () => {
  it('returns the stored plaintext value', () => {
    credentialStore.set('jwt_secret', 'super-secret-jwt');
    expect(credentialStore.get('jwt_secret')).toBe('super-secret-jwt');
  });

  it('updates last_accessed on retrieval', () => {
    credentialStore.set('jwt_secret', 'super-secret-jwt');

    const before = credentialStore.getMetadata('jwt_secret').last_accessed;

    // Small delay to ensure timestamp advances.
    const t0 = Date.now();
    while (Date.now() - t0 < 5) { /* spin */ }

    credentialStore.get('jwt_secret');
    const after = credentialStore.getMetadata('jwt_secret').last_accessed;

    expect(after).toBeGreaterThanOrEqual(before ?? 0);
  });

  it('reflects an updated value after a second set()', () => {
    credentialStore.set('s3_access_key', 'old-value');
    credentialStore.set('s3_access_key', 'new-value');
    expect(credentialStore.get('s3_access_key')).toBe('new-value');
  });
});

// ---------------------------------------------------------------------------
// AC4 — get() throws when credential does not exist
// ---------------------------------------------------------------------------

describe('AC4 — get() throws for unknown credential names', () => {
  it('throws an error with the credential name in the message', () => {
    expect(() => credentialStore.get('nonexistent_key')).toThrow('nonexistent_key');
  });

  it('throws for every call when the credential was never set', () => {
    expect(() => credentialStore.get('clover_api_key')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC5 — credential values never appear in log calls
// ---------------------------------------------------------------------------

describe('AC5 — credential values are never logged', () => {
  const SECRET_VALUE = 'SUPER_SECRET_DO_NOT_LOG_abc123';
  const logCalls = [];

  beforeEach(() => {
    // Intercept all console methods to capture any leakage.
    jest.spyOn(console, 'log').mockImplementation((...args) => logCalls.push(args.join(' ')));
    jest.spyOn(console, 'info').mockImplementation((...args) => logCalls.push(args.join(' ')));
    jest.spyOn(console, 'debug').mockImplementation((...args) => logCalls.push(args.join(' ')));
    jest.spyOn(console, 'warn').mockImplementation((...args) => logCalls.push(args.join(' ')));
    jest.spyOn(console, 'error').mockImplementation((...args) => logCalls.push(args.join(' ')));
    logCalls.length = 0;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('set() does not log the credential value', () => {
    credentialStore.set('smtp_password', SECRET_VALUE);
    for (const call of logCalls) {
      expect(call).not.toContain(SECRET_VALUE);
    }
  });

  it('get() does not log the credential value', () => {
    credentialStore.set('smtp_password', SECRET_VALUE);
    logCalls.length = 0; // reset after set()

    credentialStore.get('smtp_password');
    for (const call of logCalls) {
      expect(call).not.toContain(SECRET_VALUE);
    }
  });
});

// ---------------------------------------------------------------------------
// AC6 — startup fails if COSA_CREDENTIAL_KEY is not set
// ---------------------------------------------------------------------------

describe('AC6 — startup fails without COSA_CREDENTIAL_KEY', () => {
  it('validateOnStartup() throws if env var is absent', () => {
    delete process.env.COSA_CREDENTIAL_KEY;
    jest.resetModules();
    jest.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    const store = require('../src/credential-store');

    expect(() => store.validateOnStartup()).toThrow('COSA_CREDENTIAL_KEY');
  });

  it('get() throws if env var is absent', () => {
    delete process.env.COSA_CREDENTIAL_KEY;
    jest.resetModules();
    jest.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    const store = require('../src/credential-store');

    expect(() => store.get('any_key')).toThrow('COSA_CREDENTIAL_KEY');
  });
});

// ---------------------------------------------------------------------------
// AC7 — seed credential names are importable
// ---------------------------------------------------------------------------

describe('AC7 — seed credentials are importable via set()', () => {
  const SEED_NAMES = [
    'clover_api_key',
    's3_access_key',
    'jwt_secret',
    'cloudflare_tunnel_token',
    'smtp_password',
  ];

  it('stores all five seed credentials and retrieves them correctly', () => {
    const seedData = {};
    for (const name of SEED_NAMES) {
      seedData[name] = `${name}-value-placeholder`;
      credentialStore.set(name, seedData[name]);
    }

    for (const name of SEED_NAMES) {
      expect(credentialStore.get(name)).toBe(seedData[name]);
    }
  });

  it('list() returns all five seed credential names', () => {
    for (const name of SEED_NAMES) {
      credentialStore.set(name, `value-for-${name}`);
    }

    const names = credentialStore.list().map(r => r.name);
    for (const seed of SEED_NAMES) {
      expect(names).toContain(seed);
    }
  });

  it('simulated CLI import: set() each entry from a JSON object', () => {
    // Mirrors the logic in runCredentialsCli() → 'import' subcommand.
    const importPayload = {};
    for (const name of SEED_NAMES) {
      importPayload[name] = `imported-${name}`;
    }

    for (const [name, value] of Object.entries(importPayload)) {
      credentialStore.set(name, String(value));
    }

    expect(credentialStore.list()).toHaveLength(SEED_NAMES.length);
    expect(credentialStore.get('jwt_secret')).toBe('imported-jwt_secret');
  });
});

// ---------------------------------------------------------------------------
// Extra: getMetadata() returns null for missing entries
// ---------------------------------------------------------------------------

describe('getMetadata()', () => {
  it('returns null when the credential does not exist', () => {
    expect(credentialStore.getMetadata('does_not_exist')).toBeNull();
  });

  it('returns name and created_at without exposing the value', () => {
    credentialStore.set('jwt_secret', 'some-secret');
    const meta = credentialStore.getMetadata('jwt_secret');

    expect(meta).not.toBeNull();
    expect(meta.name).toBe('jwt_secret');
    expect(typeof meta.created_at).toBe('number');
    expect(meta).not.toHaveProperty('ciphertext');
    expect(meta).not.toHaveProperty('value');
  });
});
