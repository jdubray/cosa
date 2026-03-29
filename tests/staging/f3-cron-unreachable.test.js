'use strict';

/**
 * F-3 — Cron Health Check: Appliance Unreachable
 *
 * SSH unavailable + HTTP unreachable → COSA sends a critical alert email
 * and writes an alerts row with severity=critical.
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
jest.mock('../../src/ssh-backend', () => ({
  isConnected: () => mockSshIsConnected(),
  exec:        jest.fn(),
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

const { makeStagingConfig, makeTempDataDir, claudeToolUse, claudeEndTurn } = require('./harness');

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

  // Appliance is unreachable: SSH not connected, HTTP times out
  mockSshIsConnected.mockReturnValue(false);
  global.fetch = jest.fn().mockResolvedValue({ reachable: false })
    .mockRejectedValue(new Error('ECONNREFUSED'));

  // Claude: health_check → end_turn (text content doesn't drive alert logic)
  mockMessagesCreate
    .mockResolvedValueOnce(claudeToolUse('health_check'))
    .mockResolvedValueOnce(claudeEndTurn('Baanbaan is unreachable. SSH connection failed.'));
});

afterEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// F-3 assertions
// ---------------------------------------------------------------------------

describe('F-3 — Cron health check on unreachable appliance', () => {
  it('creates a session row for the cron trigger', async () => {
    await cronScheduler.runHealthCheckTask();
    const row = sessionStore.getDb()
      .prepare("SELECT * FROM sessions WHERE trigger_type='cron' ORDER BY id DESC LIMIT 1")
      .get();
    expect(row).toBeDefined();
  });

  it('records a tool_call with overall_status=unreachable', async () => {
    await cronScheduler.runHealthCheckTask();
    const row = sessionStore.getDb()
      .prepare("SELECT output FROM tool_calls WHERE tool_name='health_check' ORDER BY id DESC LIMIT 1")
      .get();
    expect(JSON.parse(row.output).overall_status).toBe('unreachable');
  });

  it('sends exactly one alert email to the operator', async () => {
    await cronScheduler.runHealthCheckTask();
    expect(mockSentEmails).toHaveLength(1);
    expect(mockSentEmails[0].to).toBe('operator@test.local');
  });

  it('alert email subject contains UNREACHABLE', async () => {
    await cronScheduler.runHealthCheckTask();
    expect(mockSentEmails[0].subject).toMatch(/UNREACHABLE/i);
  });

  it('inserts an alert row with severity=critical', async () => {
    await cronScheduler.runHealthCheckTask();
    const row = sessionStore.getDb()
      .prepare("SELECT * FROM alerts ORDER BY id DESC LIMIT 1")
      .get();
    expect(row).toBeDefined();
    expect(row.severity).toBe('critical');
    expect(row.category).toBe('health_check');
  });

  it('alert row has a populated sent_at timestamp', async () => {
    await cronScheduler.runHealthCheckTask();
    const row = sessionStore.getDb()
      .prepare('SELECT sent_at FROM alerts ORDER BY id DESC LIMIT 1').get();
    expect(row.sent_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('dedup: second run within 60 min sends no additional email', async () => {
    await cronScheduler.runHealthCheckTask(); // first run → sends email
    mockSentEmails.length = 0;

    // SSH is still down for second run
    mockSshIsConnected.mockReturnValue(false);
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    mockMessagesCreate
      .mockResolvedValueOnce(claudeToolUse('health_check'))
      .mockResolvedValueOnce(claudeEndTurn('Still unreachable.'));

    await cronScheduler.runHealthCheckTask(); // second run → suppressed
    expect(mockSentEmails).toHaveLength(0);
  });
});
