'use strict';

/**
 * F-5 — Operator Approval Handshake: APPROVE
 *
 * A pending approval is created synthetically.  The operator replies with
 * the APPROVE-XXXXXXXX token.  COSA updates the DB to approved and sends
 * a confirmation email.
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

  sessionStore  = require('../../src/session-store');
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
// F-5 assertions
// ---------------------------------------------------------------------------

describe('F-5 — Operator replies APPROVE-TOKEN: approval granted', () => {
  /** Create a pending approval and return the approval token from the sent email. */
  async function startApproval() {
    // Create a session so the FK constraint on approvals is satisfied
    const sessionId = require('crypto').randomUUID();
    sessionStore.createSession(sessionId, { type: 'test', source: 'staging-f5' });

    const toolCall = {
      tool_name:      'db_query',
      input:          { sql: 'SELECT COUNT(*) FROM orders' },
      riskLevel:      'medium',
      action_summary: 'Count orders for reporting',
    };

    // Start approval (don't await — it resolves only after reply)
    const approvalPromise = approvalEngine.requestApproval(sessionId, toolCall, 'once');

    // Allow the sendEmail call (which is mocked as Promise.resolve) to settle
    await flushPromises();
    await flushPromises(); // two rounds to cover nested awaits

    // Extract token from the approval request email
    const requestEmail = mockSentEmails.find(e =>
      (e.subject ?? '').includes('Approval Required') ||
      (e.text    ?? '').includes('APPROVE-')
    );
    expect(requestEmail).toBeDefined();
    const token = requestEmail.text.match(/APPROVE-[0-9A-F]{8}/)?.[0];
    expect(token).toMatch(/^APPROVE-[0-9A-F]{8}$/);

    return { approvalPromise, token, sessionId };
  }

  it('resolves the approval Promise with approved=true', async () => {
    const { approvalPromise, token } = await startApproval();

    await approvalEngine.processInboundReply({
      from:    'operator@test.local',
      subject: 'Re: approval needed',
      body:    token,
    });

    const result = await approvalPromise;
    expect(result.approved).toBe(true);
  });

  it('sets approval status to "approved" in the database', async () => {
    const { approvalPromise, token } = await startApproval();

    await approvalEngine.processInboundReply({
      from: 'operator@test.local',
      body: token,
    });
    await approvalPromise;

    const row = sessionStore.getDb()
      .prepare('SELECT status, resolved_by FROM approvals WHERE token = ?')
      .get(token);
    expect(row.status).toBe('approved');
    expect(row.resolved_by).toBe('operator@test.local');
  });

  it('sends a confirmation email to the operator', async () => {
    const { approvalPromise, token } = await startApproval();
    const emailsBefore = mockSentEmails.length;

    await approvalEngine.processInboundReply({
      from: 'operator@test.local',
      body: token,
    });
    await approvalPromise;

    const newEmails = mockSentEmails.slice(emailsBefore);
    expect(newEmails).toHaveLength(1);
    expect(newEmails[0].subject).toMatch(/approved/i);
  });

  it('uses 2-minute timeout when NODE_ENV=staging (AC10)', async () => {
    const { token } = await startApproval();
    const row = sessionStore.getDb()
      .prepare('SELECT requested_at, expires_at FROM approvals WHERE token = ?')
      .get(token);

    const diffMs = new Date(row.expires_at) - new Date(row.requested_at);
    // Should be ~2 minutes (120 000 ms) ± 5 s
    expect(diffMs).toBeGreaterThanOrEqual(115_000);
    expect(diffMs).toBeLessThanOrEqual(125_000);
  });
});
