'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');

const { _resetConfig } = require('../config/cosa.config');
const { runMigrations, closeDb } = require('../src/session-store');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_ENV = {
  ANTHROPIC_API_KEY:      'sk-ant-test',
  COSA_EMAIL_ADDRESS:     'cosa@example.com',
  COSA_EMAIL_IMAP_HOST:   'imap.example.com',
  COSA_EMAIL_IMAP_PORT:   '993',
  COSA_EMAIL_SMTP_HOST:   'smtp.example.com',
  COSA_EMAIL_SMTP_PORT:   '587',
  COSA_EMAIL_USERNAME:    'cosa@example.com',
  COSA_EMAIL_APP_PASSWORD:'test-app-password',
};

const VALID_YAML = `
appliance:
  name: "Test POS"
  timezone: "UTC"
ssh:
  host: "192.168.1.10"
  port: 22
  user: "baanbaan"
  key_path: "/home/cosa/.ssh/id_test"
operator:
  email: "owner@example.com"
  approval_timeout_minutes: 30
`;

// ---------------------------------------------------------------------------
// Test lifecycle helpers
// ---------------------------------------------------------------------------

let tmpDir;
let restoreEnv;
let originalCwd;

/**
 * Open the migrated database directly for inspection.
 * Returns an independent connection (not the session-store singleton).
 *
 * @returns {import('better-sqlite3').Database}
 */
function openDb() {
  return new Database(path.join(tmpDir, 'data', 'session.db'));
}

beforeEach(() => {
  _resetConfig();
  closeDb();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosa-db-test-'));
  fs.mkdirSync(path.join(tmpDir, 'config'));
  fs.writeFileSync(path.join(tmpDir, 'config', 'appliance.yaml'), VALID_YAML, 'utf8');

  originalCwd = process.cwd;
  process.cwd = () => tmpDir;

  const saved = {};
  Object.entries(VALID_ENV).forEach(([k, v]) => {
    saved[k] = process.env[k];
    process.env[k] = v;
  });
  restoreEnv = () => Object.entries(VALID_ENV).forEach(([k]) => {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  });
});

afterEach(() => {
  closeDb();
  process.cwd = originalCwd;
  restoreEnv();
  _resetConfig();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC1: session.db is created at data/session.db if it does not exist
// ---------------------------------------------------------------------------

describe('AC1 — database file creation', () => {
  it('creates data/session.db on first run', () => {
    runMigrations();
    expect(fs.existsSync(path.join(tmpDir, 'data', 'session.db'))).toBe(true);
  });

  it('creates the data/ directory if it does not exist', () => {
    expect(fs.existsSync(path.join(tmpDir, 'data'))).toBe(false);
    runMigrations();
    expect(fs.existsSync(path.join(tmpDir, 'data'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC2: WAL mode is enabled
// ---------------------------------------------------------------------------

describe('AC2 — WAL journal mode', () => {
  it('sets journal_mode to WAL', () => {
    runMigrations();
    const db = openDb();
    const row = db.pragma('journal_mode', { simple: true });
    db.close();
    expect(row).toBe('wal');
  });
});

// ---------------------------------------------------------------------------
// AC3: All five tables are created
// ---------------------------------------------------------------------------

describe('AC3 — five core tables', () => {
  const tables = ['sessions', 'turns', 'tool_calls', 'approvals', 'alerts'];

  beforeEach(() => runMigrations());

  tables.forEach(tableName => {
    it(`creates the ${tableName} table`, () => {
      const db = openDb();
      const row = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
      ).get(tableName);
      db.close();
      expect(row).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// AC4: FTS5 virtual table turns_fts is created and linked to turns
// ---------------------------------------------------------------------------

describe('AC4 — turns_fts virtual table', () => {
  beforeEach(() => runMigrations());

  it('creates the turns_fts virtual table', () => {
    const db = openDb();
    const row = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='turns_fts'`
    ).get();
    db.close();
    expect(row).toBeDefined();
  });

  it('turns_fts is an fts5 virtual table', () => {
    const db = openDb();
    const row = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='turns_fts'`
    ).get();
    db.close();
    expect(row.sql).toMatch(/fts5/i);
  });

  it('turns_fts links content= back to the turns table', () => {
    const db = openDb();
    const row = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='turns_fts'`
    ).get();
    db.close();
    expect(row.sql).toMatch(/content=turns/i);
  });
});

// ---------------------------------------------------------------------------
// AC5: All indexes defined in the spec are created
// ---------------------------------------------------------------------------

describe('AC5 — indexes', () => {
  const expectedIndexes = [
    'idx_sessions_trigger_type',
    'idx_sessions_started_at',
    'idx_turns_session_id',
    'idx_tool_calls_session_id',
    'idx_tool_calls_tool_name',
    'idx_tool_calls_status',
    'idx_approvals_token',
    'idx_approvals_status',
    'idx_approvals_expires_at',
  ];

  beforeEach(() => runMigrations());

  expectedIndexes.forEach(indexName => {
    it(`creates index ${indexName}`, () => {
      const db = openDb();
      const row = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name=?`
      ).get(indexName);
      db.close();
      expect(row).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// AC6: Migrations are idempotent
// ---------------------------------------------------------------------------

describe('AC6 — idempotency', () => {
  it('does not throw when called twice in the same process', () => {
    expect(() => {
      runMigrations();
      runMigrations();
    }).not.toThrow();
  });

  it('does not throw when called after the db is closed and reopened', () => {
    expect(() => {
      runMigrations();
      closeDb();
      _resetConfig();
      runMigrations();
    }).not.toThrow();
  });

  it('produces the same schema on the second run', () => {
    runMigrations();
    closeDb();
    _resetConfig();
    runMigrations();

    const db = openDb();
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    ).all().map(r => r.name);
    db.close();

    expect(tables).toEqual(
      expect.arrayContaining(['alerts', 'approvals', 'sessions', 'tool_calls', 'turns', 'turns_fts'])
    );
  });
});
