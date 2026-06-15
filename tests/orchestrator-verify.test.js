'use strict';

// ---------------------------------------------------------------------------
// Orchestrator wiring for Layer-A computational verification: processToolUse
// must call the action verifier ONLY for an action-role session that runs a
// mutating tool which actually dispatched, and append the verdict block to the
// model-facing tool_result. Runs the real tool-registry + session-store; stubs
// the security/approval side-channels and the verifier (unit-tested elsewhere).
// ---------------------------------------------------------------------------

const path = require('path');
const fs   = require('fs');
const os   = require('os');

jest.mock('../src/security-gate', () => ({
  check:          jest.fn().mockResolvedValue({ blocked: false }),
  sanitizeOutput: (o) => (typeof o === 'string' ? o : JSON.stringify(o)),
}));
jest.mock('../src/approval-engine', () => ({
  requiresApproval: jest.fn().mockReturnValue('none'),
  requestApproval:  jest.fn(),
}));

const mockVerify        = jest.fn();
const mockFormatVerdict = jest.fn(() => '[[VERIFY-BLOCK]]');
jest.mock('../src/action-verifier', () => ({
  verify:        (...a) => mockVerify(...a),
  formatVerdict: (...a) => mockFormatVerdict(...a),
}));

const { _resetConfig }   = require('../config/cosa.config');
const sessionStore       = require('../src/session-store');
const toolRegistry       = require('../src/tool-registry');
const { processToolUse } = require('../src/orchestrator');

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
tools:
  health_check:
    enabled: true
  restart_appliance:
    enabled: true
`;

const SCHEMA = { description: 'x', inputSchema: { type: 'object', properties: {}, additionalProperties: true } };

let tmpDir, restoreEnv, originalCwd, mutatingHandler, readHandler;

beforeEach(() => {
  jest.clearAllMocks();
  _resetConfig();
  sessionStore.closeDb();
  toolRegistry._reset();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosa-verify-test-'));
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

  readHandler     = jest.fn().mockResolvedValue({ overall_status: 'healthy' });
  mutatingHandler = jest.fn().mockResolvedValue({ restarted: true });
  toolRegistry.register('health_check', SCHEMA, readHandler, 'read');
  toolRegistry.register('restart_appliance', SCHEMA, mutatingHandler, 'high');

  // Default verdict: a failed verification (the interesting case).
  mockVerify.mockResolvedValue({ status: 'failed', probe: 'health_check', attempts: 2 });
});

afterEach(() => {
  sessionStore.closeDb();
  toolRegistry._reset();
  process.cwd = originalCwd;
  restoreEnv();
  _resetConfig();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function tu(name, input = {}) {
  return { type: 'tool_use', id: 'tu1', name, input };
}

describe('processToolUse — Layer-A verification wiring', () => {
  it('AC9: verifies an action-role mutating tool and appends the verdict block', async () => {
    sessionStore.createSession('s1', { type: 'cron' }, { agentRole: 'action' });

    const res = await processToolUse('s1', tu('restart_appliance', { reason: 'x' }), 'cron', 'action');

    expect(mutatingHandler).toHaveBeenCalledTimes(1);
    expect(mockVerify).toHaveBeenCalledWith('restart_appliance', { reason: 'x' });
    expect(res.content).toContain('[[VERIFY-BLOCK]]');
    // Original tool output is preserved above the verdict.
    expect(res.content).toContain('restarted');
  });

  it('AC10: does NOT verify a read tool even for the action role', async () => {
    sessionStore.createSession('s2', { type: 'cron' }, { agentRole: 'action' });

    const res = await processToolUse('s2', tu('health_check'), 'cron', 'action');

    expect(readHandler).toHaveBeenCalledTimes(1);
    expect(mockVerify).not.toHaveBeenCalled();
    expect(res.content).not.toContain('[[VERIFY-BLOCK]]');
  });

  it('AC10: does NOT verify for a read-only role', async () => {
    sessionStore.createSession('s3', { type: 'cron' }, { agentRole: 'query' });

    await processToolUse('s3', tu('health_check'), 'cron', 'query');

    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('AC11: does NOT verify when the mutating tool threw (dispatch errored)', async () => {
    mutatingHandler.mockRejectedValue(new Error('boom'));
    sessionStore.createSession('s4', { type: 'cron' }, { agentRole: 'action' });

    const res = await processToolUse('s4', tu('restart_appliance'), 'cron', 'action');

    expect(mockVerify).not.toHaveBeenCalled();
    expect(res.content).toContain('boom');          // error surfaced to the model
    expect(res.content).not.toContain('[[VERIFY-BLOCK]]');
  });

  it('appends nothing when the verifier returns null (no matching policy)', async () => {
    mockVerify.mockResolvedValue(null);
    sessionStore.createSession('s5', { type: 'cron' }, { agentRole: 'action' });

    const res = await processToolUse('s5', tu('restart_appliance'), 'cron', 'action');

    expect(mockVerify).toHaveBeenCalledTimes(1);
    expect(mockFormatVerdict).not.toHaveBeenCalled();
    expect(res.content).not.toContain('[[VERIFY-BLOCK]]');
  });

  it('never breaks the tool result if the verifier throws', async () => {
    mockVerify.mockRejectedValue(new Error('verifier exploded'));
    sessionStore.createSession('s6', { type: 'cron' }, { agentRole: 'action' });

    const res = await processToolUse('s6', tu('restart_appliance'), 'cron', 'action');

    expect(res.is_error).toBeUndefined();
    expect(res.content).toContain('restarted');
  });
});
