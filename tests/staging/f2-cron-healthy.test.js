'use strict';

/**
 * F-2 — Cron Health Check: Appliance Healthy
 *
 * Cron fires → COSA runs health_check → appliance is healthy →
 * session row created, NO alert email, NO alerts table row.
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

// IMAP — no inbox messages for cron tests
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

const { makeStagingConfig, makeTempDataDir, SYSTEMCTL_HEALTHY, claudeToolUse, claudeEndTurn } =
  require('./harness');

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
  mockSshIsConnected.mockReturnValue(true);
  mockSshExec.mockResolvedValue({ stdout: SYSTEMCTL_HEALTHY, stderr: '', exitCode: 0 });
  global.fetch = jest.fn()
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ status: 'ok' }) })
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ ready: true }) });
  mockMessagesCreate
    .mockResolvedValueOnce(claudeToolUse('health_check'))
    .mockResolvedValueOnce(claudeEndTurn('Baanbaan is healthy.'));
});

afterEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// F-2 assertions
// ---------------------------------------------------------------------------

describe('F-2 — Cron health check on healthy appliance', () => {
  it('creates a session row with trigger_type=cron and trigger_source=health-check', async () => {
    await cronScheduler.runHealthCheckTask();
    const row = sessionStore.getDb()
      .prepare("SELECT * FROM sessions WHERE trigger_type='cron' ORDER BY id DESC LIMIT 1")
      .get();
    expect(row).toBeDefined();
    expect(row.trigger_type).toBe('cron');
    expect(row.trigger_source).toBe('health-check');
  });

  it('closes the session with status=complete', async () => {
    await cronScheduler.runHealthCheckTask();
    const row = sessionStore.getDb()
      .prepare("SELECT status FROM sessions WHERE trigger_type='cron' ORDER BY id DESC LIMIT 1")
      .get();
    expect(row.status).toBe('complete');
  });

  it('records the health_check tool call as executed', async () => {
    await cronScheduler.runHealthCheckTask();
    const row = sessionStore.getDb()
      .prepare("SELECT status, output FROM tool_calls WHERE tool_name='health_check' ORDER BY id DESC LIMIT 1")
      .get();
    expect(row.status).toBe('executed');
    expect(JSON.parse(row.output).overall_status).toBe('healthy');
  });

  it('sends NO email to the operator', async () => {
    await cronScheduler.runHealthCheckTask();
    expect(mockSentEmails).toHaveLength(0);
  });

  it('creates NO alert row in the alerts table', async () => {
    await cronScheduler.runHealthCheckTask();
    const count = sessionStore.getDb()
      .prepare('SELECT COUNT(*) AS n FROM alerts').get().n;
    expect(count).toBe(0);
  });
});
