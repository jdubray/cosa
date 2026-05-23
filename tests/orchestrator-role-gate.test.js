'use strict';

// ---------------------------------------------------------------------------
// Execution-time role gate (HIGH security fix): a read-only role (query/probe/
// audit) must be PREVENTED FROM EXECUTING a mutating tool even if it appears in
// a tool_use block — getSchemas(role) filtering is advertisement only. Runs the
// real tool-registry + session-store; stubs only the security/approval/email
// side-channels (unit-tested elsewhere).
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

const { _resetConfig } = require('../config/cosa.config');
const sessionStore     = require('../src/session-store');
const toolRegistry     = require('../src/tool-registry');
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

let tmpDir, restoreEnv, originalCwd, restartHandler, healthHandler;

beforeEach(() => {
  jest.clearAllMocks();
  _resetConfig();
  sessionStore.closeDb();
  toolRegistry._reset();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosa-rolegate-test-'));
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

  healthHandler  = jest.fn().mockResolvedValue({ overall_status: 'healthy' });
  restartHandler = jest.fn().mockResolvedValue({ restarted: true });
  toolRegistry.register('health_check', SCHEMA, healthHandler, 'read');
  toolRegistry.register('restart_appliance', SCHEMA, restartHandler, 'high');
});

afterEach(() => {
  sessionStore.closeDb();
  toolRegistry._reset();
  process.cwd = originalCwd;
  restoreEnv();
  _resetConfig();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function tu(name) {
  return { type: 'tool_use', id: 'tu1', name, input: {} };
}

describe('execution-time role gate', () => {
  it('blocks a query (read-only) role from executing a mutating tool', async () => {
    sessionStore.createSession('s-query', { type: 'cron' }, { agentRole: 'query' });

    const res = await processToolUse('s-query', tu('restart_appliance'), 'cron', 'query');

    expect(res.is_error).toBe(true);
    expect(res.content).toMatch(/not permitted/i);
    expect(restartHandler).not.toHaveBeenCalled();          // critical: never dispatched
  });

  it('blocks a probe role from a mutating tool too', async () => {
    sessionStore.createSession('s-probe', { type: 'cron' }, { agentRole: 'probe' });

    const res = await processToolUse('s-probe', tu('restart_appliance'), 'cron', 'probe');

    expect(res.is_error).toBe(true);
    expect(restartHandler).not.toHaveBeenCalled();
  });

  it('allows a read-only role to run a read tool', async () => {
    sessionStore.createSession('s-query2', { type: 'cron' }, { agentRole: 'query' });

    const res = await processToolUse('s-query2', tu('health_check'), 'cron', 'query');

    expect(res.is_error).toBeUndefined();
    expect(healthHandler).toHaveBeenCalledTimes(1);
  });

  it('allows the action role to run a mutating tool (gate does not over-block)', async () => {
    sessionStore.createSession('s-action', { type: 'cron' }, { agentRole: 'action' });

    const res = await processToolUse('s-action', tu('restart_appliance'), 'cron', 'action');

    expect(res.is_error).toBeUndefined();
    expect(restartHandler).toHaveBeenCalledTimes(1);
  });
});
