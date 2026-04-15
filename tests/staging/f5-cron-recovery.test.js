'use strict';

/**
 * F-5 — Cron Health Check: Recovery Notification
 *
 * A prior alert (critical or warning) exists in the DB.
 * Cron fires → appliance is now healthy → COSA sends a "[COSA Resolved]"
 * email and writes an alerts row with severity=resolved.
 *
 * Second healthy run → no duplicate recovery email (last alert is 'resolved').
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

const { makeStagingConfig, makeTempDataDir, SYSTEMCTL_HEALTHY } = require('./harness');

let cronScheduler;
let sessionStore;
let toolRegistry;

/** Seed a critical health_check alert row so the recovery path is triggered. */
function seedCriticalAlert() {
  sessionStore.createAlert({
    session_id: 'seed-session-id',
    severity:   'critical',
    category:   'health_check',
    title:      'Baanbaan POS (Staging) is UNREACHABLE',
    body:       'COSA automated health check detected an issue:\n\nStatus: UNREACHABLE',
    sent_at:    new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 min ago
    email_to:   'operator@test.local',
  });
}

/** Configure mocks so the appliance appears healthy. */
function setupHealthyAppliance() {
  mockSshIsConnected.mockReturnValue(true);
  mockSshExec.mockResolvedValue({ stdout: SYSTEMCTL_HEALTHY, stderr: '', exitCode: 0 });
  global.fetch = jest.fn()
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ status: 'ok' }) })
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ ready: true }) });
}

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
  setupHealthyAppliance();
});

afterEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// F-5 assertions
// ---------------------------------------------------------------------------

describe('F-5 — Cron health check recovery notification', () => {
  it('sends a recovery email when the appliance returns to healthy after a critical alert', async () => {
    seedCriticalAlert();
    await cronScheduler.runHealthCheckTask();
    expect(mockSentEmails).toHaveLength(1);
    expect(mockSentEmails[0].to).toBe('operator@test.local');
  });

  it('recovery email subject contains RESOLVED', async () => {
    seedCriticalAlert();
    await cronScheduler.runHealthCheckTask();
    expect(mockSentEmails[0].subject).toMatch(/RESOLVED/i);
  });

  it('recovery email body indicates status is HEALTHY', async () => {
    seedCriticalAlert();
    await cronScheduler.runHealthCheckTask();
    expect(mockSentEmails[0].text).toMatch(/HEALTHY/i);
  });

  it('inserts an alert row with severity=resolved', async () => {
    seedCriticalAlert();
    await cronScheduler.runHealthCheckTask();
    const row = sessionStore.getDb()
      .prepare("SELECT * FROM alerts WHERE severity='resolved' ORDER BY id DESC LIMIT 1")
      .get();
    expect(row).toBeDefined();
    expect(row.severity).toBe('resolved');
    expect(row.category).toBe('health_check');
  });

  it('does NOT send a second recovery email on the next healthy run', async () => {
    seedCriticalAlert();
    await cronScheduler.runHealthCheckTask(); // first healthy run → recovery sent
    mockSentEmails.length = 0;

    // second healthy run — last alert is now 'resolved', no further email
    setupHealthyAppliance();
    await cronScheduler.runHealthCheckTask();
    expect(mockSentEmails).toHaveLength(0);
  });

  it('sends NO email when already healthy with no prior alert', async () => {
    // No seedCriticalAlert() call — DB has no health_check alerts
    await cronScheduler.runHealthCheckTask();
    expect(mockSentEmails).toHaveLength(0);
  });
});
