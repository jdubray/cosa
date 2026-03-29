'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');

const { _resetConfig } = require('../config/cosa.config');
const {
  runMigrations,
  closeDb,
  createSession,
  closeSession,
  saveTurn,
  saveToolCall,
  recordBlockedToolCall,
  createApproval,
  findApprovalByToken,
  updateApprovalStatus,
} = require('../src/session-store');

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

// Reusable IDs across tests within the same describe block
const SESSION_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const SESSION_B = 'aaaaaaaa-0000-0000-0000-000000000002';

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let tmpDir;
let restoreEnv;
let originalCwd;

/** Open an independent connection for assertion queries (not the singleton). */
function openDb() {
  return new Database(path.join(tmpDir, 'data', 'session.db'));
}

beforeEach(() => {
  _resetConfig();
  closeDb();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosa-crud-test-'));
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

  runMigrations();
});

afterEach(() => {
  closeDb();
  process.cwd = originalCwd;
  restoreEnv();
  _resetConfig();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC1 — createSession
// ---------------------------------------------------------------------------

describe('createSession()', () => {
  it('inserts a row with the correct session_id and trigger_type', () => {
    createSession(SESSION_A, { type: 'cron', source: 'health_check' });

    const db = openDb();
    const row = db.prepare(`SELECT * FROM sessions WHERE session_id = ?`).get(SESSION_A);
    db.close();

    expect(row.session_id).toBe(SESSION_A);
    expect(row.trigger_type).toBe('cron');
    expect(row.trigger_source).toBe('health_check');
  });

  it("sets status to 'open' and records started_at", () => {
    createSession(SESSION_A, { type: 'email', source: 'owner@example.com' });

    const db = openDb();
    const row = db.prepare(`SELECT * FROM sessions WHERE session_id = ?`).get(SESSION_A);
    db.close();

    expect(row.status).toBe('open');
    expect(row.started_at).toBeTruthy();
  });

  it('accepts a trigger with no source (cli trigger)', () => {
    createSession(SESSION_A, { type: 'cli' });

    const db = openDb();
    const row = db.prepare(`SELECT * FROM sessions WHERE session_id = ?`).get(SESSION_A);
    db.close();

    expect(row.trigger_source).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC2 — saveTurn
// ---------------------------------------------------------------------------

describe('saveTurn()', () => {
  beforeEach(() => createSession(SESSION_A, { type: 'cron' }));

  it('inserts a turn row with the correct role and content', () => {
    saveTurn(SESSION_A, 'user', 'Run health check', null, null);

    const db = openDb();
    const row = db.prepare(`SELECT * FROM turns WHERE session_id = ?`).get(SESSION_A);
    db.close();

    expect(row.role).toBe('user');
    expect(row.content).toBe('Run health check');
  });

  it('assigns turn_index 0 for the first turn', () => {
    saveTurn(SESSION_A, 'user', 'first', null, null);

    const db = openDb();
    const row = db.prepare(`SELECT turn_index FROM turns WHERE session_id = ?`).get(SESSION_A);
    db.close();

    expect(row.turn_index).toBe(0);
  });

  it('increments turn_index for each subsequent turn', () => {
    saveTurn(SESSION_A, 'user',      'msg 1', null, null);
    saveTurn(SESSION_A, 'assistant', 'msg 2', 10, 20);
    saveTurn(SESSION_A, 'tool',      'msg 3', null, null);

    const db = openDb();
    const rows = db.prepare(
      `SELECT turn_index FROM turns WHERE session_id = ? ORDER BY turn_index`
    ).all(SESSION_A);
    db.close();

    expect(rows.map(r => r.turn_index)).toEqual([0, 1, 2]);
  });

  it('stores token counts', () => {
    saveTurn(SESSION_A, 'assistant', 'reply', 50, 120);

    const db = openDb();
    const row = db.prepare(`SELECT tokens_in, tokens_out FROM turns WHERE session_id = ?`).get(SESSION_A);
    db.close();

    expect(row.tokens_in).toBe(50);
    expect(row.tokens_out).toBe(120);
  });

  it('keeps turn_index independent across sessions', () => {
    createSession(SESSION_B, { type: 'email' });
    saveTurn(SESSION_A, 'user', 'session A turn 0', null, null);
    saveTurn(SESSION_B, 'user', 'session B turn 0', null, null);

    const db = openDb();
    const a = db.prepare(`SELECT turn_index FROM turns WHERE session_id = ?`).get(SESSION_A);
    const b = db.prepare(`SELECT turn_index FROM turns WHERE session_id = ?`).get(SESSION_B);
    db.close();

    expect(a.turn_index).toBe(0);
    expect(b.turn_index).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC3 — saveToolCall
// ---------------------------------------------------------------------------

describe('saveToolCall()', () => {
  beforeEach(() => createSession(SESSION_A, { type: 'cron' }));

  it('inserts an executed tool_call row', () => {
    const toolCall = { tool_name: 'health_check', input: { target: 'api' }, risk_level: 'read', duration_ms: 142 };
    const result = { healthy: true };
    saveToolCall(SESSION_A, toolCall, result, 'executed');

    const db = openDb();
    const row = db.prepare(`SELECT * FROM tool_calls WHERE session_id = ?`).get(SESSION_A);
    db.close();

    expect(row.tool_name).toBe('health_check');
    expect(row.status).toBe('executed');
    expect(row.risk_level).toBe('read');
    expect(row.duration_ms).toBe(142);
  });

  it('serialises input and output as JSON strings', () => {
    const toolCall = { tool_name: 'db_query', input: { sql: 'SELECT 1' } };
    const result = { rows: [{ '1': 1 }] };
    saveToolCall(SESSION_A, toolCall, result, 'executed');

    const db = openDb();
    const row = db.prepare(`SELECT input, output FROM tool_calls WHERE session_id = ?`).get(SESSION_A);
    db.close();

    expect(JSON.parse(row.input)).toEqual({ sql: 'SELECT 1' });
    expect(JSON.parse(row.output)).toEqual({ rows: [{ '1': 1 }] });
  });

  it('stores null output when result is null (pending_approval)', () => {
    const toolCall = { tool_name: 'db_query', input: { sql: 'SELECT 1' } };
    saveToolCall(SESSION_A, toolCall, null, 'pending_approval');

    const db = openDb();
    const row = db.prepare(`SELECT output FROM tool_calls WHERE session_id = ?`).get(SESSION_A);
    db.close();

    expect(row.output).toBeNull();
  });

  it('returns the inserted row id', () => {
    const id = saveToolCall(SESSION_A, { tool_name: 'health_check', input: {} }, null, 'executed');
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC4 — recordBlockedToolCall
// ---------------------------------------------------------------------------

describe('recordBlockedToolCall()', () => {
  beforeEach(() => createSession(SESSION_A, { type: 'cron' }));

  it("inserts a tool_call row with status 'blocked'", () => {
    const toolCall = { tool_name: 'ssh_exec', input: { command: 'rm -rf /' }, risk_level: 'critical' };
    recordBlockedToolCall(SESSION_A, toolCall, 'Recursive delete detected');

    const db = openDb();
    const row = db.prepare(`SELECT * FROM tool_calls WHERE session_id = ?`).get(SESSION_A);
    db.close();

    expect(row.status).toBe('blocked');
    expect(row.tool_name).toBe('ssh_exec');
  });

  it('stores the block reason in the output column', () => {
    recordBlockedToolCall(SESSION_A, { tool_name: 'ssh_exec', input: {} }, 'Dangerous command pattern');

    const db = openDb();
    const row = db.prepare(`SELECT output FROM tool_calls WHERE session_id = ?`).get(SESSION_A);
    db.close();

    expect(row.output).toBe('Dangerous command pattern');
  });

  it('returns the inserted row id', () => {
    const id = recordBlockedToolCall(SESSION_A, { tool_name: 'ssh_exec', input: {} }, 'reason');
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC5 — createApproval
// ---------------------------------------------------------------------------

describe('createApproval()', () => {
  const APPROVAL_ID = 'approval-uuid-0001';
  const TOKEN = 'APPROVE-ABCD1234';
  const EXPIRES = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  beforeEach(() => createSession(SESSION_A, { type: 'email' }));

  it('inserts an approval row with status pending', () => {
    createApproval({
      approval_id:    APPROVAL_ID,
      session_id:     SESSION_A,
      token:          TOKEN,
      tool_name:      'db_integrity',
      action_summary: 'Run WAL checkpoint on Baanbaan DB',
      risk_level:     'medium',
      expires_at:     EXPIRES,
    });

    const db = openDb();
    const row = db.prepare(`SELECT * FROM approvals WHERE approval_id = ?`).get(APPROVAL_ID);
    db.close();

    expect(row.approval_id).toBe(APPROVAL_ID);
    expect(row.token).toBe(TOKEN);
    expect(row.status).toBe('pending');
    expect(row.scope).toBe('once');
  });

  it('accepts a custom scope', () => {
    createApproval({
      approval_id:    APPROVAL_ID,
      session_id:     SESSION_A,
      token:          TOKEN,
      tool_name:      'db_integrity',
      action_summary: 'summary',
      risk_level:     'high',
      scope:          'session',
      expires_at:     EXPIRES,
    });

    const db = openDb();
    const row = db.prepare(`SELECT scope FROM approvals WHERE approval_id = ?`).get(APPROVAL_ID);
    db.close();

    expect(row.scope).toBe('session');
  });
});

// ---------------------------------------------------------------------------
// AC6 — findApprovalByToken
// ---------------------------------------------------------------------------

describe('findApprovalByToken()', () => {
  const APPROVAL_ID = 'approval-uuid-0002';
  const TOKEN = 'APPROVE-ZZZZ9999';
  const EXPIRES = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  beforeEach(() => {
    createSession(SESSION_A, { type: 'email' });
    createApproval({
      approval_id:    APPROVAL_ID,
      session_id:     SESSION_A,
      token:          TOKEN,
      tool_name:      'health_check',
      action_summary: 'Restart baanbaan service',
      risk_level:     'high',
      expires_at:     EXPIRES,
    });
  });

  it('returns the matching approval row by token', () => {
    const row = findApprovalByToken(TOKEN);
    expect(row).toBeDefined();
    expect(row.approval_id).toBe(APPROVAL_ID);
  });

  it('returns undefined for an unknown token', () => {
    const row = findApprovalByToken('APPROVE-UNKNOWN0');
    expect(row).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC7 — updateApprovalStatus
// ---------------------------------------------------------------------------

describe('updateApprovalStatus()', () => {
  const APPROVAL_ID = 'approval-uuid-0003';
  const TOKEN = 'APPROVE-UPDT1111';
  const EXPIRES = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  beforeEach(() => {
    createSession(SESSION_A, { type: 'email' });
    createApproval({
      approval_id:    APPROVAL_ID,
      session_id:     SESSION_A,
      token:          TOKEN,
      tool_name:      'health_check',
      action_summary: 'Restart service',
      risk_level:     'high',
      expires_at:     EXPIRES,
    });
  });

  it("updates status to 'approved'", () => {
    updateApprovalStatus(APPROVAL_ID, 'approved', 'owner@example.com', null);

    const db = openDb();
    const row = db.prepare(`SELECT status, resolved_by FROM approvals WHERE approval_id = ?`).get(APPROVAL_ID);
    db.close();

    expect(row.status).toBe('approved');
    expect(row.resolved_by).toBe('owner@example.com');
  });

  it("updates status to 'denied' with an operator note", () => {
    updateApprovalStatus(APPROVAL_ID, 'denied', 'owner@example.com', 'Not now');

    const db = openDb();
    const row = db.prepare(`SELECT status, operator_note FROM approvals WHERE approval_id = ?`).get(APPROVAL_ID);
    db.close();

    expect(row.status).toBe('denied');
    expect(row.operator_note).toBe('Not now');
  });

  it("updates status to 'expired' by system", () => {
    updateApprovalStatus(APPROVAL_ID, 'expired', 'system', null);

    const db = openDb();
    const row = db.prepare(`SELECT status, resolved_by FROM approvals WHERE approval_id = ?`).get(APPROVAL_ID);
    db.close();

    expect(row.status).toBe('expired');
    expect(row.resolved_by).toBe('system');
  });

  it('records resolved_at timestamp', () => {
    updateApprovalStatus(APPROVAL_ID, 'approved', 'owner@example.com', null);

    const db = openDb();
    const row = db.prepare(`SELECT resolved_at FROM approvals WHERE approval_id = ?`).get(APPROVAL_ID);
    db.close();

    expect(row.resolved_at).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// AC8 — closeSession
// ---------------------------------------------------------------------------

describe('closeSession()', () => {
  beforeEach(() => createSession(SESSION_A, { type: 'cron' }));

  it("sets status to 'complete'", () => {
    closeSession(SESSION_A, 'Health check passed');

    const db = openDb();
    const row = db.prepare(`SELECT status FROM sessions WHERE session_id = ?`).get(SESSION_A);
    db.close();

    expect(row.status).toBe('complete');
  });

  it('stores the summary', () => {
    closeSession(SESSION_A, 'Baanbaan healthy — no action taken');

    const db = openDb();
    const row = db.prepare(`SELECT summary FROM sessions WHERE session_id = ?`).get(SESSION_A);
    db.close();

    expect(row.summary).toBe('Baanbaan healthy — no action taken');
  });

  it('records completed_at timestamp', () => {
    closeSession(SESSION_A, 'done');

    const db = openDb();
    const row = db.prepare(`SELECT completed_at FROM sessions WHERE session_id = ?`).get(SESSION_A);
    db.close();

    expect(row.completed_at).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// AC9 — parameterized queries (no SQL injection risk)
// ---------------------------------------------------------------------------

describe('AC9 — parameterized queries', () => {
  it('handles SQL metacharacters in session_id without error', () => {
    // If interpolation were used instead of params this would break or inject
    const maliciousId = `' OR '1'='1`;
    expect(() => createSession(maliciousId, { type: 'cli' })).not.toThrow();

    const db = openDb();
    const row = db.prepare(`SELECT session_id FROM sessions WHERE session_id = ?`).get(maliciousId);
    db.close();
    expect(row.session_id).toBe(maliciousId);
  });

  it('handles SQL metacharacters in turn content without error', () => {
    createSession(SESSION_A, { type: 'cli' });
    const maliciousContent = `'); DROP TABLE turns; --`;
    expect(() => saveTurn(SESSION_A, 'user', maliciousContent, null, null)).not.toThrow();

    const db = openDb();
    const row = db.prepare(`SELECT content FROM turns WHERE session_id = ?`).get(SESSION_A);
    db.close();
    expect(row.content).toBe(maliciousContent);
  });

  it('handles SQL metacharacters in approval token without error', () => {
    createSession(SESSION_A, { type: 'email' });
    const maliciousToken = `APPROVE-' OR '1'='1`;
    expect(() => createApproval({
      approval_id:    'appr-inject-test',
      session_id:     SESSION_A,
      token:          maliciousToken,
      tool_name:      'health_check',
      action_summary: 'test',
      risk_level:     'read',
      expires_at:     new Date(Date.now() + 1800000).toISOString(),
    })).not.toThrow();

    const row = findApprovalByToken(maliciousToken);
    expect(row).toBeDefined();
    expect(row.token).toBe(maliciousToken);
  });
});
