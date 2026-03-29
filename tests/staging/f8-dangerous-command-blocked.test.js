'use strict';

/**
 * F-8 — Security Gate: Dangerous Command Blocked
 *
 * Claude returns a db_query tool call with a DROP TABLE statement.
 * The security gate intercepts it before execution, records a blocked
 * tool_call row, and the session closes without any SQL being executed.
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

const mockSshExec = jest.fn();
jest.mock('../../src/ssh-backend', () => ({
  isConnected: jest.fn().mockReturnValue(false),
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

const { makeStagingConfig, makeTempDataDir, claudeToolUse, claudeEndTurn } =
  require('./harness');

let orchestrator;
let sessionStore;
let toolRegistry;

beforeAll(() => {
  process.env.NODE_ENV = 'staging';
  mockStagingConfig    = makeStagingConfig(makeTempDataDir());

  sessionStore = require('../../src/session-store');
  sessionStore.runMigrations();

  // Register only the tools that tests exercise; db_query is not registered
  // intentionally — the security gate must block the call before dispatch.
  toolRegistry = require('../../src/tool-registry');

  orchestrator = require('../../src/orchestrator');
});

afterAll(() => {
  sessionStore.closeDb();
  toolRegistry._reset();
  delete process.env.NODE_ENV;
});

beforeEach(() => {
  mockSentEmails.length = 0;
  mockSshExec.mockReset();

  // Round 1: Claude requests DROP TABLE via db_query.
  // Round 2: Claude receives the "blocked" error result and ends the turn.
  mockMessagesCreate
    .mockResolvedValueOnce(claudeToolUse('db_query', { sql: 'DROP TABLE orders;' }))
    .mockResolvedValueOnce(claudeEndTurn('I cannot execute that operation — it was blocked.'));
});

afterEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// F-8 assertions
// ---------------------------------------------------------------------------

describe('F-8 — DROP TABLE blocked before execution', () => {
  async function runDropTableSession() {
    return orchestrator.runSession({
      type:    'email',
      source:  'operator',
      message: 'Please clean up the orders table by dropping it.',
    });
  }

  it('records the tool_call with status=blocked', async () => {
    await runDropTableSession();
    const row = sessionStore.getDb()
      .prepare("SELECT status, tool_name FROM tool_calls WHERE tool_name='db_query' ORDER BY id DESC LIMIT 1")
      .get();
    expect(row).toBeDefined();
    expect(row.status).toBe('blocked');
  });

  it('stores the block reason in the output column', async () => {
    await runDropTableSession();
    const row = sessionStore.getDb()
      .prepare("SELECT output FROM tool_calls WHERE tool_name='db_query' ORDER BY id DESC LIMIT 1")
      .get();
    // output for blocked calls contains the reason string
    expect(row.output).toMatch(/destructive sql/i);
  });

  it('never calls ssh-backend.exec (SQL was never dispatched)', async () => {
    await runDropTableSession();
    expect(mockSshExec).not.toHaveBeenCalled();
  });

  it('session closes with status=complete', async () => {
    await runDropTableSession();
    const row = sessionStore.getDb()
      .prepare("SELECT status FROM sessions ORDER BY id DESC LIMIT 1")
      .get();
    expect(row.status).toBe('complete');
  });

  it('sends no email to the operator (security block is silent)', async () => {
    await runDropTableSession();
    expect(mockSentEmails).toHaveLength(0);
  });

  it('Claude is called twice: once for tool_use, once after the blocked result', async () => {
    await runDropTableSession();
    expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
  });
});
