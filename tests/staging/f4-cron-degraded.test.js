'use strict';

/**
 * F-4 — Cron Health Check: Appliance Degraded
 *
 * SSH connected, HTTP reachable, but systemd shows restarts > 0 →
 * overall_status=degraded → warning alert email sent.
 */

// ---------------------------------------------------------------------------
// Boundary mocks
// ---------------------------------------------------------------------------

const mockMessagesCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () =>
  jest.fn(() => ({ messages: { create: (...a) => mockMessagesCreate(...a) } }))
);

let mockStagingConfig;
jest.mock('../../config/cosa.config', () => ({
  getConfig:    () => mockStagingConfig,
  _resetConfig: () => {},
}));

const mockSshIsConnected = jest.fn();
const mockSshExec        = jest.fn();
jest.mock('../../src/ssh-backend', () => ({
  isConnected: () => mockSshIsConnected(),
  exec:        (...a) => mockSshExec(...a),
  init:        jest.fn().mockResolvedValue(undefined),
  disconnect:  jest.fn(),
}));

jest.mock('imapflow', () => ({
  ImapFlow: jest.fn().mockImplementation(() => ({
    connect:         jest.fn().mockResolvedValue(undefined),
    getMailboxLock:  jest.fn().mockResolvedValue({ release: jest.fn() }),
    search:          jest.fn().mockResolvedValue([]),
    fetchOne:        jest.fn(),
    messageFlagsAdd: jest.fn().mockResolvedValue(undefined),
    logout:          jest.fn().mockResolvedValue(undefined),
  })),
}));

const mockSentEmails = [];
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({
    sendMail: jest.fn((opts) => {
      mockSentEmails.push({ ...opts });
      return Promise.resolve({ messageId: '<sent@test>' });
    }),
  })),
}));

jest.mock('../../src/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const {
  makeStagingConfig, makeTempDataDir,
  SYSTEMCTL_DEGRADED, claudeToolUse, claudeEndTurn,
} = require('./harness');

let cronScheduler;
let sessionStore;
let toolRegistry;

beforeAll(() => {
  process.env.NODE_ENV = 'staging';
  mockStagingConfig    = makeStagingConfig(makeTempDataDir());

  sessionStore = require('../../src/session-store');
  sessionStore.runMigrations();

  toolRegistry = require('../../src/tool-registry');
  const hc = require('../../src/tools/health-check');
  toolRegistry.register(hc.name, hc.schema, hc.handler, hc.riskLevel);

  cronScheduler = require('../../src/cron-scheduler');
});

afterAll(() => {
  cronScheduler.stop();
  sessionStore.closeDb();
  toolRegistry._reset();
  delete process.env.NODE_ENV;
});

beforeEach(() => {
  mockSentEmails.length = 0;

  // SSH up; systemd shows 3 restarts → degraded
  mockSshIsConnected.mockReturnValue(true);
  mockSshExec.mockResolvedValue({ stdout: SYSTEMCTL_DEGRADED, stderr: '', exitCode: 0 });

  // HTTP endpoints reachable
  global.fetch = jest.fn()
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ status: 'ok' }) })
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ ready: true }) });

  mockMessagesCreate
    .mockResolvedValueOnce(claudeToolUse('health_check'))
    .mockResolvedValueOnce(claudeEndTurn('Baanbaan is degraded — 3 service restarts detected.'));
});

afterEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// F-4 assertions
// ---------------------------------------------------------------------------

describe('F-4 — Cron health check on degraded appliance', () => {
  it('records overall_status=degraded in tool_calls output', async () => {
    await cronScheduler.runHealthCheckTask();
    const row = sessionStore.getDb()
      .prepare("SELECT output FROM tool_calls WHERE tool_name='health_check' ORDER BY id DESC LIMIT 1")
      .get();
    expect(JSON.parse(row.output).overall_status).toBe('degraded');
  });

  it('sends exactly one alert email to the operator', async () => {
    await cronScheduler.runHealthCheckTask();
    expect(mockSentEmails).toHaveLength(1);
    expect(mockSentEmails[0].to).toBe('operator@test.local');
  });

  it('alert email subject contains DEGRADED', async () => {
    await cronScheduler.runHealthCheckTask();
    expect(mockSentEmails[0].subject).toMatch(/DEGRADED/i);
  });

  it('alert email body mentions restarts', async () => {
    await cronScheduler.runHealthCheckTask();
    expect(mockSentEmails[0].text).toMatch(/restart/i);
  });

  it('inserts an alert row with severity=warning', async () => {
    await cronScheduler.runHealthCheckTask();
    const row = sessionStore.getDb()
      .prepare('SELECT severity, category FROM alerts ORDER BY id DESC LIMIT 1').get();
    expect(row.severity).toBe('warning');
    expect(row.category).toBe('health_check');
  });

  it('alert email is plain text (no html field)', async () => {
    await cronScheduler.runHealthCheckTask();
    expect(mockSentEmails[0]).not.toHaveProperty('html');
  });
});
