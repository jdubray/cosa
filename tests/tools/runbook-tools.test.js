'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');

// Mock the executor so runbook_trigger does not actually dispatch tools.
const mockExecute = jest.fn();
jest.mock('../../src/runbook-executor', () => ({
  executeRunbook: (...a) => mockExecute(...a),
}));

const { _resetConfig } = require('../../config/cosa.config');
const sessionStore     = require('../../src/session-store');
const runbookStore     = require('../../src/runbook-store');

const upsertTool  = require('../../src/tools/runbook-upsert');
const listTool    = require('../../src/tools/runbook-list');
const triggerTool = require('../../src/tools/runbook-trigger');

// ---------------------------------------------------------------------------
// Harness
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
ssh:
  host: "192.168.1.10"
  port: 22
  user: "baanbaan"
  key_path: "/home/cosa/.ssh/id_test"
operator:
  email: "owner@example.com"
  approval_timeout_minutes: 30
`;

let tmpDir, restoreEnv, originalCwd;

beforeEach(() => {
  jest.clearAllMocks();
  _resetConfig();
  sessionStore.closeDb();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosa-rbtools-test-'));
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

const STEPS = [{ tool_name: 'health_check', input: {} }];

// ---------------------------------------------------------------------------
// Metadata / risk levels
// ---------------------------------------------------------------------------

describe('runbook tools — metadata', () => {
  it('have the expected names and risk levels', () => {
    expect(upsertTool.name).toBe('runbook_upsert');
    expect(upsertTool.riskLevel).toBe('medium');
    expect(listTool.name).toBe('runbook_list');
    expect(listTool.riskLevel).toBe('read');
    expect(triggerTool.name).toBe('runbook_trigger');
    expect(triggerTool.riskLevel).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// runbook_upsert
// ---------------------------------------------------------------------------

describe('runbook_upsert', () => {
  it('creates a runbook and reports version', async () => {
    const res = await upsertTool.handler({ name: 'rb1', description: 'desc', steps: STEPS });
    expect(res).toMatchObject({ success: true, name: 'rb1', version: 1 });
    expect(runbookStore.get('rb1')).not.toBeNull();
  });

  it('returns a structured failure on invalid input rather than throwing', async () => {
    const res = await upsertTool.handler({ name: 'Bad Name', description: 'd', steps: STEPS });
    expect(res.success).toBe(false);
    expect(res.code).toBe('RUNBOOK_INVALID');
  });
});

// ---------------------------------------------------------------------------
// runbook_list
// ---------------------------------------------------------------------------

describe('runbook_list', () => {
  it('lists stored runbooks with summary fields', async () => {
    await upsertTool.handler({ name: 'rb1', description: 'first', steps: STEPS, auto_approved: true });
    const res = await listTool.handler({});
    expect(res.success).toBe(true);
    expect(res.count).toBe(1);
    expect(res.runbooks[0]).toMatchObject({ name: 'rb1', version: 1, auto_approved: true });
  });

  it('returns an empty list when none exist', async () => {
    const res = await listTool.handler({});
    expect(res).toMatchObject({ success: true, count: 0, runbooks: [] });
  });
});

// ---------------------------------------------------------------------------
// runbook_trigger
// ---------------------------------------------------------------------------

describe('runbook_trigger', () => {
  it('returns RUNBOOK_NOT_FOUND when the runbook does not exist', async () => {
    const res = await triggerTool.handler({ name: 'ghost' });
    expect(res).toMatchObject({ success: false, code: 'RUNBOOK_NOT_FOUND' });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('executes an existing runbook and maps success outcome', async () => {
    await upsertTool.handler({ name: 'rb1', description: 'd', steps: STEPS });
    mockExecute.mockResolvedValue({ outcome: 'success', converged: true, iterations: 1, stepsLog: [] });

    const res = await triggerTool.handler({ name: 'rb1', reason: 'manual test' });
    expect(mockExecute).toHaveBeenCalledWith('rb1', { source: 'manual_trigger', reason: 'manual test' });
    expect(res.success).toBe(true);
    expect(res.outcome).toBe('success');
  });

  it('reports success=false for a non-success outcome', async () => {
    await upsertTool.handler({ name: 'rb1', description: 'd', steps: STEPS });
    mockExecute.mockResolvedValue({ outcome: 'aborted', converged: null, iterations: 0, stepsLog: [] });

    const res = await triggerTool.handler({ name: 'rb1' });
    expect(res.success).toBe(false);
    expect(res.outcome).toBe('aborted');
  });
});
