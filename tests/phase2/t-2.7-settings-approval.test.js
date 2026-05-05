'use strict';

/**
 * T-2.7 — Settings Change Approval
 *
 * An email requesting a settings change triggers the approval engine.
 * The operator replies with the APPROVE-XXXXXXXX token → approval is granted
 * → the tool executes and a confirmation is sent.
 *
 * If the operator replies DENY-XXXXXXXX → tool is blocked.
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
  makeStagingConfig, makeTempDataDir, claudeToolUse, claudeEndTurn, flushPromises,
} = require('./harness');

let approvalEngine;
let orchestrator;
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

  approvalEngine = require('../../src/approval-engine');

  toolRegistry = require('../../src/tool-registry');
  const sw = require('../../src/tools/settings-write');
  toolRegistry.register(sw.name, sw.schema, sw.handler, sw.riskLevel);

  orchestrator = require('../../src/orchestrator');
});

afterAll(() => {
  approvalEngine.stopExpiryCheck();
  approvalEngine._clearPending();
  sessionStore.closeDb();
  toolRegistry._reset();
  delete process.env.NODE_ENV;
});

beforeEach(() => {
  mockSentEmails.length = 0;
  approvalEngine._clearPending();
});

afterEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// T-2.7 assertions
// ---------------------------------------------------------------------------

describe('T-2.7 — Settings change approval flow', () => {
  it('requiresApproval returns "once" for settings_write (high risk)', () => {
    const policy = approvalEngine.requiresApproval({
      tool_name: 'settings_write',
      input:     { key: 'ssh.port', value: '2222' },
      riskLevel: 'high',
    });
    expect(policy).toBe('once');
  });

  it.skip('sends an approval-request email when settings_write is proposed', async () => {
    // Claude proposes settings_write; approval engine intercepts and sends email.
    mockMessagesCreate
      .mockResolvedValueOnce(claudeToolUse('settings_write', { key: 'logging.level', value: 'debug' }))
      .mockResolvedValueOnce(claudeEndTurn('Settings change denied or pending.'));

    // Override requestApproval to immediately deny (simulates timeout / no reply).
    jest.spyOn(approvalEngine, 'requestApproval').mockResolvedValueOnce({
      approved: false,
      note:     'Test denial',
    });

    await orchestrator.runSession({
      type:    'email',
      source:  'operator@test.local',
      message: 'Please set logging.level to debug.',
    });

    expect(approvalEngine.requestApproval).toHaveBeenCalled();
  });

  it('tool executes when approval is granted', async () => {
    mockMessagesCreate
      .mockResolvedValueOnce(claudeToolUse('settings_write', { key: 'logging.level', value: 'info' }))
      .mockResolvedValueOnce(claudeEndTurn('Settings updated.'));

    jest.spyOn(approvalEngine, 'requestApproval').mockResolvedValueOnce({
      approved: true,
      note:     'Approved by operator',
    });

    const { session_id: sessionId } = await orchestrator.runSession({
      type:    'email',
      source:  'operator@test.local',
      message: 'Please set logging.level to info.',
    });

    const row = sessionStore.getDb()
      .prepare("SELECT status FROM tool_calls WHERE tool_name='settings_write' AND session_id=? ORDER BY id DESC LIMIT 1")
      .get(sessionId);
    expect(row?.status).toBe('executed');
  });

  it.skip('tool is denied and recorded when approval is rejected', async () => {
    mockMessagesCreate
      .mockResolvedValueOnce(claudeToolUse('settings_write', { key: 'logging.level', value: 'warn' }))
      .mockResolvedValueOnce(claudeEndTurn('Settings change denied.'));

    jest.spyOn(approvalEngine, 'requestApproval').mockResolvedValueOnce({
      approved: false,
      note:     'Denied by operator',
    });

    const { session_id: sessionId } = await orchestrator.runSession({
      type:    'email',
      source:  'operator@test.local',
      message: 'Please set logging.level to warn.',
    });

    const row = sessionStore.getDb()
      .prepare("SELECT status FROM tool_calls WHERE tool_name='settings_write' AND session_id=? ORDER BY id DESC LIMIT 1")
      .get(sessionId);
    expect(row?.status).toBe('denied');
  });
});
