'use strict';

/**
 * T-2.2 — Shift Report Email Delivery
 *
 * Cron fires shift_report → COSA generates report → email sent with correct
 * subject "[COSA] Shift Report: YYYY-MM-DD".
 * Deduplication: second call within 6 hours produces no second email.
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

jest.mock('../../src/ssh-backend', () => ({
  isConnected: jest.fn().mockReturnValue(true),
  exec:        jest.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
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
  claudeToolUse, claudeEndTurn,
} = require('./harness');

const SHIFT_REPORT_BODY = `Daily Shift Report
==================
Health checks: 24 runs, all healthy.
Backups: 1 successful.
No anomalies detected.

— COSA`;

let cronScheduler;
let sessionStore;
let toolRegistry;

beforeAll(() => {
  process.env.NODE_ENV = 'staging';
  mockStagingConfig    = makeStagingConfig(makeTempDataDir());

  sessionStore = require('../../src/session-store');
  sessionStore.runMigrations();

  const skillStore = require('../../src/skill-store');
  skillStore.runMigrations();

  toolRegistry = require('../../src/tool-registry');
  const sr = require('../../src/tools/shift-report');
  toolRegistry.register(sr.name, sr.schema, sr.handler, sr.riskLevel);

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
  // Claude calls shift_report then writes the full report as its final response.
  mockMessagesCreate
    .mockResolvedValueOnce(claudeToolUse('shift_report'))
    .mockResolvedValueOnce(claudeEndTurn(SHIFT_REPORT_BODY));
});

afterEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// T-2.2 assertions
// ---------------------------------------------------------------------------

describe('T-2.2 — Shift report email delivery', () => {
  it('sends one email to the operator', async () => {
    await cronScheduler.runShiftReportTask();
    expect(mockSentEmails).toHaveLength(1);
    expect(mockSentEmails[0].to).toBe('operator@test.local');
  });

  it('email subject matches [COSA] Shift Report: YYYY-MM-DD', async () => {
    await cronScheduler.runShiftReportTask();
    const today = new Date().toISOString().slice(0, 10);
    expect(mockSentEmails[0].subject).toBe(`[COSA] Shift Report: ${today}`);
  });

  it('email body is the orchestrator response (plain text)', async () => {
    await cronScheduler.runShiftReportTask();
    expect(mockSentEmails[0].text).toContain('Daily Shift Report');
  });

  it('creates an alert row with category=shift_report', async () => {
    await cronScheduler.runShiftReportTask();
    const row = sessionStore.getDb()
      .prepare("SELECT category, severity FROM alerts WHERE category='shift_report' ORDER BY id DESC LIMIT 1")
      .get();
    expect(row).toBeDefined();
    expect(row.severity).toBe('info');
  });

  it('does NOT send a second email when called again within dedup window', async () => {
    // First call sent an email (from previous test or this run).
    // Reset emails, run again — should be suppressed.
    mockSentEmails.length = 0;
    // Re-mock Claude for second call attempt.
    mockMessagesCreate
      .mockResolvedValueOnce(claudeToolUse('shift_report'))
      .mockResolvedValueOnce(claudeEndTurn(SHIFT_REPORT_BODY));

    await cronScheduler.runShiftReportTask();
    // An alert row already exists from previous test; dedup should suppress.
    expect(mockSentEmails).toHaveLength(0);
  });
});
