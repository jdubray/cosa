'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const { _resetConfig } = require('../config/cosa.config');
const sessionStore     = require('../src/session-store');
const runbookStore     = require('../src/runbook-store');

// ---------------------------------------------------------------------------
// Harness (mirrors tests/session-store-crud.test.js)
// ---------------------------------------------------------------------------

const VALID_ENV = {
  ANTHROPIC_API_KEY:       'sk-ant-test',
  COSA_EMAIL_ADDRESS:      'cosa@example.com',
  COSA_EMAIL_IMAP_HOST:    'imap.example.com',
  COSA_EMAIL_IMAP_PORT:    '993',
  COSA_EMAIL_SMTP_HOST:    'smtp.example.com',
  COSA_EMAIL_SMTP_PORT:    '587',
  COSA_EMAIL_USERNAME:     'cosa@example.com',
  COSA_EMAIL_APP_PASSWORD: 'test-app-password',
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

let tmpDir;
let restoreEnv;
let originalCwd;

beforeEach(() => {
  _resetConfig();
  sessionStore.closeDb();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosa-runbook-test-'));
  fs.mkdirSync(path.join(tmpDir, 'config'));
  fs.writeFileSync(path.join(tmpDir, 'config', 'appliance.yaml'), VALID_YAML, 'utf8');

  originalCwd = process.cwd;
  process.cwd = () => tmpDir;

  const saved = {};
  Object.entries(VALID_ENV).forEach(([k, v]) => { saved[k] = process.env[k]; process.env[k] = v; });
  restoreEnv = () => Object.entries(VALID_ENV).forEach(([k]) => {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  });

  sessionStore.runMigrations();
  runbookStore.runMigrations();
});

afterEach(() => {
  sessionStore.closeDb();
  process.cwd = originalCwd;
  restoreEnv();
  _resetConfig();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const VALID = {
  name:        'restart_pos',
  description: 'Restart the POS service when it is down.',
  steps:       [{ tool_name: 'health_check', input: {} }],
};

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

describe('runMigrations', () => {
  it('creates runbooks and runbook_runs tables', () => {
    const db = sessionStore.getDb();
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('runbooks','runbook_runs')`
    ).all().map(r => r.name).sort();
    expect(tables).toEqual(['runbook_runs', 'runbooks']);
  });

  it('is idempotent', () => {
    expect(() => { runbookStore.runMigrations(); runbookStore.runMigrations(); }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// upsert / get / list / remove
// ---------------------------------------------------------------------------

describe('upsert + get', () => {
  it('creates a runbook at version 1', () => {
    const res = runbookStore.upsert(VALID);
    expect(res).toEqual({ name: 'restart_pos', version: 1 });
    const row = runbookStore.get('restart_pos');
    expect(row.description).toBe(VALID.description);
    expect(JSON.parse(row.steps)).toEqual(VALID.steps);
    expect(row.auto_approved).toBe(0);
    expect(row.max_iterations).toBe(3);
    expect(row.on_failure).toBe('alert');
  });

  it('bumps version and preserves created_at on update', () => {
    runbookStore.upsert(VALID);
    const first = runbookStore.get('restart_pos');
    const res = runbookStore.upsert({ ...VALID, description: 'Updated.' });
    expect(res.version).toBe(2);
    const second = runbookStore.get('restart_pos');
    expect(second.description).toBe('Updated.');
    expect(second.created_at).toBe(first.created_at);
  });

  it('stores convergence, max_iterations, on_failure, auto_approved', () => {
    runbookStore.upsert({
      ...VALID,
      convergence:   { tool_name: 'health_check', input: {}, check_field: 'overall_status', expect_value: 'healthy' },
      maxIterations: 5,
      onFailure:     'abort',
      autoApproved:  true,
    });
    const row = runbookStore.get('restart_pos');
    expect(JSON.parse(row.convergence).check_field).toBe('overall_status');
    expect(row.max_iterations).toBe(5);
    expect(row.on_failure).toBe('abort');
    expect(row.auto_approved).toBe(1);
  });

  it('returns null for a missing runbook', () => {
    expect(runbookStore.get('nope')).toBeNull();
  });
});

describe('upsert validation', () => {
  const cases = [
    ['bad name',        { ...VALID, name: 'Bad Name!' }],
    ['empty steps',     { ...VALID, steps: [] }],
    ['step missing tool_name', { ...VALID, steps: [{ input: {} }] }],
    ['max_iterations too high', { ...VALID, maxIterations: 99 }],
    ['bad on_failure',  { ...VALID, onFailure: 'explode' }],
    ['array input',     { ...VALID, steps: [{ tool_name: 'x', input: [] }] }],
  ];
  it.each(cases)('rejects %s with RUNBOOK_INVALID', (_label, payload) => {
    expect(() => runbookStore.upsert(payload)).toThrow();
    try { runbookStore.upsert(payload); } catch (e) { expect(e.code).toBe('RUNBOOK_INVALID'); }
  });
});

describe('list + remove', () => {
  it('lists summary metadata sorted by name', () => {
    runbookStore.upsert({ ...VALID, name: 'zeta' });
    runbookStore.upsert({ ...VALID, name: 'alpha' });
    const names = runbookStore.list().map(r => r.name);
    expect(names).toEqual(['alpha', 'zeta']);
    expect(runbookStore.list()[0]).toHaveProperty('version');
    expect(runbookStore.list()[0]).not.toHaveProperty('steps');
  });

  it('removes a runbook and reports whether one was deleted', () => {
    runbookStore.upsert(VALID);
    expect(runbookStore.remove('restart_pos')).toBe(true);
    expect(runbookStore.get('restart_pos')).toBeNull();
    expect(runbookStore.remove('restart_pos')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

describe('logRun + updateRun + getRun', () => {
  it('logs a run in running state and patches whitelisted columns', () => {
    const id = runbookStore.logRun({ runbook_name: 'restart_pos', trigger_ctx: '{"x":1}' });
    let run = runbookStore.getRun(id);
    expect(run.outcome).toBe('running');
    expect(run.iterations).toBe(0);

    runbookStore.updateRun(id, { iterations: 2, converged: 1, outcome: 'success', finished_at: '2026-05-20T00:00:00Z' });
    run = runbookStore.getRun(id);
    expect(run.iterations).toBe(2);
    expect(run.converged).toBe(1);
    expect(run.outcome).toBe('success');
    expect(run.finished_at).toBe('2026-05-20T00:00:00Z');
  });

  it('ignores non-whitelisted patch keys', () => {
    const id = runbookStore.logRun({ runbook_name: 'r', trigger_ctx: '{}' });
    expect(() => runbookStore.updateRun(id, { runbook_name: 'hacked', bogus: 1 })).not.toThrow();
    expect(runbookStore.getRun(id).runbook_name).toBe('r');
  });
});
