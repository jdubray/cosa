'use strict';

/**
 * F-7 — Operator Approval Handshake: Expired (no reply)
 *
 * A pending approval is created synthetically.  The operator does not reply
 * before the deadline.  COSA's expiry sweep detects the overdue request,
 * marks it expired, sends a notification email, and resolves the pending
 * Promise with approved=false, note='expired'.
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

const { makeStagingConfig, makeTempDataDir, flushPromises } = require('./harness');

let approvalEngine;
let sessionStore;

beforeAll(() => {
  process.env.NODE_ENV = 'staging';
  mockStagingConfig    = makeStagingConfig(makeTempDataDir());

  sessionStore   = require('../../src/session-store');
  sessionStore.runMigrations();
  approvalEngine = require('../../src/approval-engine');
});

afterAll(() => {
  approvalEngine.stopExpiryCheck();
  approvalEngine._clearPending();
  sessionStore.closeDb();
  delete process.env.NODE_ENV;
});

beforeEach(() => {
  mockSentEmails.length = 0;
  approvalEngine._clearPending();
});

afterEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a pending approval, flush send-email promises, extract the token,
 * then back-date expires_at so the expiry sweep picks it up immediately.
 */
async function startExpiredApproval() {
  const sessionId = require('crypto').randomUUID();
  sessionStore.createSession(sessionId, { type: 'test', source: 'staging-f7' });

  const toolCall = {
    tool_name:      'db_query',
    input:          { sql: 'SELECT * FROM sessions LIMIT 10' },
    riskLevel:      'medium',
    action_summary: 'Inspect recent sessions',
  };

  const approvalPromise = approvalEngine.requestApproval(sessionId, toolCall, 'once');

  await flushPromises();
  await flushPromises();

  const requestEmail = mockSentEmails.find(e =>
    (e.subject ?? '').includes('Approval Required') ||
    (e.text    ?? '').includes('APPROVE-')
  );
  expect(requestEmail).toBeDefined();
  const token = requestEmail.text.match(/APPROVE-[0-9A-F]{8}/)?.[0];
  expect(token).toMatch(/^APPROVE-[0-9A-F]{8}$/);

  // Back-date expires_at so the row is already expired when _runExpiryCheck runs.
  sessionStore.getDb()
    .prepare('UPDATE approvals SET expires_at = ? WHERE token = ?')
    .run(new Date(Date.now() - 60_000).toISOString(), token);

  return { approvalPromise, token, sessionId };
}

// ---------------------------------------------------------------------------
// F-7 assertions
// ---------------------------------------------------------------------------

describe('F-7 — Approval expires without operator reply', () => {
  it('resolves the approval Promise with approved=false', async () => {
    const { approvalPromise } = await startExpiredApproval();

    await approvalEngine._runExpiryCheck();

    const result = await approvalPromise;
    expect(result.approved).toBe(false);
  });

  it('resolves with note="expired"', async () => {
    const { approvalPromise } = await startExpiredApproval();

    await approvalEngine._runExpiryCheck();

    const result = await approvalPromise;
    expect(result.note).toBe('expired');
  });

  it('sets approval status to "expired" in the database', async () => {
    const { approvalPromise, token } = await startExpiredApproval();

    await approvalEngine._runExpiryCheck();
    await approvalPromise;

    const row = sessionStore.getDb()
      .prepare('SELECT status, resolved_by FROM approvals WHERE token = ?')
      .get(token);
    expect(row.status).toBe('expired');
    expect(row.resolved_by).toBe('system');
  });

  it('sends a notification email to the operator', async () => {
    const { approvalPromise } = await startExpiredApproval();
    const emailsBefore = mockSentEmails.length;

    await approvalEngine._runExpiryCheck();
    await approvalPromise;

    const newEmails = mockSentEmails.slice(emailsBefore);
    expect(newEmails).toHaveLength(1);
    expect(newEmails[0].subject).toMatch(/expired/i);
  });

  it('notification email body mentions the tool name', async () => {
    const { approvalPromise } = await startExpiredApproval();
    const emailsBefore = mockSentEmails.length;

    await approvalEngine._runExpiryCheck();
    await approvalPromise;

    const email = mockSentEmails.slice(emailsBefore)[0];
    expect(email.text).toMatch(/db_query/i);
  });

  it('does not process already-expired approvals a second time', async () => {
    const { approvalPromise } = await startExpiredApproval();

    await approvalEngine._runExpiryCheck(); // first sweep
    await approvalPromise;
    mockSentEmails.length = 0;

    await approvalEngine._runExpiryCheck(); // second sweep — already expired
    expect(mockSentEmails).toHaveLength(0);
  });
});
