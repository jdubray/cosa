'use strict';

// ---------------------------------------------------------------------------
// Sprint 4 hardening — end-to-end runbook execution through the REAL store,
// tool-registry, and executor (G7/G8/G9/G10). Only the security gate and email
// gateway are stubbed (unit-tested elsewhere; we don't want real SMTP/Tirith).
// ---------------------------------------------------------------------------

const path = require('path');
const fs   = require('fs');
const os   = require('os');

jest.mock('../src/security-gate', () => ({ check: jest.fn().mockResolvedValue({ blocked: false }) }));
const mockSendEmail = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/email-gateway', () => ({ sendEmail: (...a) => mockSendEmail(...a) }));

const { _resetConfig } = require('../config/cosa.config');
const sessionStore     = require('../src/session-store');
const runbookStore     = require('../src/runbook-store');
const toolRegistry     = require('../src/tool-registry');
const { executeRunbook } = require('../src/runbook-executor');

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

// Enable the two real tools we use as runbook steps.
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

let tmpDir, restoreEnv, originalCwd;
let healthHandler, restartHandler;

beforeEach(() => {
  jest.clearAllMocks();
  _resetConfig();
  sessionStore.closeDb();
  toolRegistry._reset();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosa-rbgate-test-'));
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

  // health_check = read; restart_appliance = high. Register with real risk levels.
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

function lastRun(name) {
  return sessionStore.getDb()
    .prepare(`SELECT * FROM runbook_runs WHERE runbook_name = ? ORDER BY id DESC LIMIT 1`)
    .get(name);
}

// ---------------------------------------------------------------------------
// G7/G8 — round-trip + deterministic execution
// ---------------------------------------------------------------------------

it('G8: executes read-only steps deterministically and converges to success', async () => {
  runbookStore.upsert({
    name:        'check_health',
    description: 'verify health',
    steps:       [{ tool_name: 'health_check', input: {} }],
    convergence: { tool_name: 'health_check', input: {}, check_field: 'overall_status', expect_value: 'healthy' },
  });

  const result = await executeRunbook('check_health', { source: 'test' });

  expect(result.outcome).toBe('success');
  expect(result.converged).toBe(true);
  expect(healthHandler).toHaveBeenCalled();
  expect(restartHandler).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Gating — non-read step requires auto_approved (real getRiskLevel)
// ---------------------------------------------------------------------------

it('aborts a non-read step when the runbook is not auto_approved — tool never runs', async () => {
  runbookStore.upsert({
    name:        'restart_unsafe',
    description: 'restart without approval',
    steps:       [{ tool_name: 'restart_appliance', input: {} }],
  });

  const result = await executeRunbook('restart_unsafe', { source: 'test' });

  expect(result.outcome).toBe('aborted');
  expect(restartHandler).not.toHaveBeenCalled();          // critical: nothing executed
  expect(mockSendEmail).toHaveBeenCalledTimes(1);          // operator alerted
});

it('runs a non-read step when the runbook IS auto_approved', async () => {
  runbookStore.upsert({
    name:         'restart_ok',
    description:  'restart with pre-authorisation',
    steps:        [{ tool_name: 'restart_appliance', input: {} }],
    autoApproved: true,
  });

  const result = await executeRunbook('restart_ok', { source: 'test' });

  expect(result.outcome).toBe('success');
  expect(restartHandler).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// G9/G10 — run logging + max-iteration guard
// ---------------------------------------------------------------------------

it('G9: records the run outcome and convergence in runbook_runs', async () => {
  runbookStore.upsert({
    name:        'check_health2',
    description: 'verify',
    steps:       [{ tool_name: 'health_check', input: {} }],
    convergence: { tool_name: 'health_check', input: {}, check_field: 'overall_status', expect_value: 'healthy' },
  });
  await executeRunbook('check_health2', {});
  const run = lastRun('check_health2');
  expect(run.outcome).toBe('success');
  expect(run.converged).toBe(1);
  expect(run.finished_at).toBeTruthy();
});

it('G10: stops at max_iterations and fails when convergence is never reached', async () => {
  healthHandler.mockResolvedValue({ overall_status: 'degraded' }); // never healthy
  runbookStore.upsert({
    name:          'never_converges',
    description:   'will not converge',
    steps:         [{ tool_name: 'health_check', input: {} }],
    convergence:   { tool_name: 'health_check', input: {}, check_field: 'overall_status', expect_value: 'healthy' },
    maxIterations: 2,
  });

  const result = await executeRunbook('never_converges', {});
  expect(result.outcome).toBe('failed');
  expect(result.converged).toBe(false);

  const run = lastRun('never_converges');
  expect(run.iterations).toBe(2);     // capped
  expect(run.outcome).toBe('failed');
  expect(mockSendEmail).toHaveBeenCalledTimes(1);
});
