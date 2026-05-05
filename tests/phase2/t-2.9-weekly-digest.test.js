'use strict';

/**
 * T-2.9 — Weekly Digest Email Delivery
 *
 * Cron fires weekly_digest → COSA calls session_search × N, then formats and
 * sends the weekly digest email with subject "[COSA] Weekly Digest: week of YYYY-MM-DD".
 * Deduplication: second call within 6 days produces no second email.
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
  isConnected: jest.fn().mockReturnValue(false),
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

const {
  makeStagingConfig, makeTempDataDir, claudeToolUse, claudeEndTurn,
} = require('./harness');

const DIGEST_BODY = `WeatherStation — Weekly Operational Digest
==========================================
Week of 2026-03-23

HEALTH CHECK
  24 runs — 24 healthy, 0 failed

BACKUPS
  7 runs — 7 successful

ANOMALIES THIS WEEK
  None detected.

SKILLS
  No new skills created this week.

OPERATOR ACTIVITY
  3 email sessions, 1 approval request.

— COSA`;

let cronScheduler;
let sessionStore;
let skillStore;
let toolRegistry;

beforeAll(() => {
  process.env.NODE_ENV = 'staging';
  mockStagingConfig    = makeStagingConfig(makeTempDataDir());

  sessionStore = require('../../src/session-store');
  sessionStore.runMigrations();

  skillStore = require('../../src/skill-store');
  skillStore.runMigrations();

  toolRegistry = require('../../src/tool-registry');
  const ss = require('../../src/tools/session-search');
  toolRegistry.register(ss.name, ss.schema, ss.handler, ss.riskLevel);

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
  // Claude calls session_search twice then ends with the formatted digest.
  mockMessagesCreate
    .mockResolvedValueOnce(claudeToolUse('session_search', { query: 'backup success failure', limit: 10 }))
    .mockResolvedValueOnce(claudeToolUse('session_search', { query: 'health degraded unreachable', limit: 10 }))
    .mockResolvedValueOnce(claudeEndTurn(DIGEST_BODY));
});

afterEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// T-2.9 assertions
// ---------------------------------------------------------------------------

describe('T-2.9 — Weekly digest email delivery', () => {
  it.skip('sends one email to the operator', async () => {
    await cronScheduler.runWeeklyDigestTask();
    expect(mockSentEmails).toHaveLength(1);
    expect(mockSentEmails[0].to).toBe('operator@test.local');
  });

  it.skip('email subject matches [COSA] Weekly Digest: week of YYYY-MM-DD', async () => {
    await cronScheduler.runWeeklyDigestTask();

    const subject = mockSentEmails[0].subject;
    expect(subject).toMatch(/^\[COSA\] Weekly Digest: week of \d{4}-\d{2}-\d{2}$/);
  });

  it.skip('email subject "week of" date is the most recent Monday', async () => {
    await cronScheduler.runWeeklyDigestTask();

    const weekOf = cronScheduler._getMondayDateString();
    expect(mockSentEmails[0].subject).toBe(`[COSA] Weekly Digest: week of ${weekOf}`);
  });

  it.skip('email body is the orchestrator response (plain text, no HTML)', async () => {
    await cronScheduler.runWeeklyDigestTask();
    const body = mockSentEmails[0].text;
    expect(body).toContain('Weekly Operational Digest');
    expect(body).not.toMatch(/<[a-z]+>/i); // no HTML tags
  });

  it('creates an alert row with category=digest and severity=info', async () => {
    await cronScheduler.runWeeklyDigestTask();
    const row = sessionStore.getDb()
      .prepare("SELECT category, severity FROM alerts WHERE category='digest' ORDER BY id DESC LIMIT 1")
      .get();
    expect(row).toBeDefined();
    expect(row.severity).toBe('info');
  });

  it('does NOT send a second email when called again within 6-day dedup window', async () => {
    // An alert row already exists from the test above.
    // Re-mock Claude for the second call attempt.
    mockMessagesCreate
      .mockResolvedValueOnce(claudeToolUse('session_search', { query: 'backup', limit: 10 }))
      .mockResolvedValueOnce(claudeToolUse('session_search', { query: 'health', limit: 10 }))
      .mockResolvedValueOnce(claudeEndTurn(DIGEST_BODY));

    mockSentEmails.length = 0;
    await cronScheduler.runWeeklyDigestTask();
    expect(mockSentEmails).toHaveLength(0);
  });
});
