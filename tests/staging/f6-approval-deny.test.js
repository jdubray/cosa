'use strict';

/**
 * F-6 — Operator Approval Handshake: DENY
 *
 * A pending approval is created synthetically.  The operator replies with
 * "DENY APPROVE-XXXXXXXX [reason]".  COSA updates the DB to denied and sends
 * a cancellation email.
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
// F-6 assertions
// ---------------------------------------------------------------------------

describe('F-6 — Operator replies DENY-TOKEN: approval denied', () => {
  /** Create a pending approval and return the approval token from the sent email. */
  async function startApproval() {
    const sessionId = require('crypto').randomUUID();
    sessionStore.createSession(sessionId, { type: 'test', source: 'staging-f6' });

    const toolCall = {
      tool_name:      'db_query',
      input:          { sql: 'DELETE FROM audit_logs WHERE created_at < date("now", "-90 days")' },
      riskLevel:      'high',
      action_summary: 'Purge old audit logs',
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

    return { approvalPromise, token, sessionId };
  }

  it('resolves the approval Promise with approved=false', async () => {
    const { approvalPromise, token } = await startApproval();

    await approvalEngine.processInboundReply({
      from:    'operator@test.local',
      subject: 'Re: approval needed',
      body:    `DENY ${token}`,
    });

    const result = await approvalPromise;
    expect(result.approved).toBe(false);
  });

  it('preserves the operator note in the resolved value', async () => {
    const { approvalPromise, token } = await startApproval();

    await approvalEngine.processInboundReply({
      from: 'operator@test.local',
      body: `DENY ${token} Not authorised right now`,
    });

    const result = await approvalPromise;
    expect(result.approved).toBe(false);
    expect(result.note).toBe('Not authorised right now');
  });

  it('sets approval status to "denied" in the database', async () => {
    const { approvalPromise, token } = await startApproval();

    await approvalEngine.processInboundReply({
      from: 'operator@test.local',
      body: `DENY ${token}`,
    });
    await approvalPromise;

    const row = sessionStore.getDb()
      .prepare('SELECT status, resolved_by FROM approvals WHERE token = ?')
      .get(token);
    expect(row.status).toBe('denied');
    expect(row.resolved_by).toBe('operator@test.local');
  });

  it('sends a cancellation email to the operator', async () => {
    const { approvalPromise, token } = await startApproval();
    const emailsBefore = mockSentEmails.length;

    await approvalEngine.processInboundReply({
      from: 'operator@test.local',
      body: `DENY ${token}`,
    });
    await approvalPromise;

    const newEmails = mockSentEmails.slice(emailsBefore);
    expect(newEmails).toHaveLength(1);
    expect(newEmails[0].subject).toMatch(/denied/i);
  });

  it('stores the operator note in the database', async () => {
    const { approvalPromise, token } = await startApproval();

    await approvalEngine.processInboundReply({
      from: 'operator@test.local',
      body: `DENY ${token} Security concern`,
    });
    await approvalPromise;

    const row = sessionStore.getDb()
      .prepare('SELECT operator_note FROM approvals WHERE token = ?')
      .get(token);
    expect(row.operator_note).toBe('Security concern');
  });
});
