'use strict';

/**
 * F-1 — Operator Queries Health via Email
 *
 * Operator sends "Is Baanbaan okay?" to the COSA inbox.
 * COSA polls IMAP, starts an orchestrator session, calls health_check,
 * and sends a reply email to the operator.
 *
 * Real modules: orchestrator, email-gateway, approval-engine, security-gate,
 *               tool-registry, context-builder, session-store, health-check tool
 * Mocked boundaries: @anthropic-ai/sdk, ssh-backend, fetch, imapflow,
 *                    nodemailer, config, logger
 */

// ---------------------------------------------------------------------------
// Boundary mocks  (must be declared before any require)
// ---------------------------------------------------------------------------

// ── @anthropic-ai/sdk ────────────────────────────────────────────────────────
const mockMessagesCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () =>
  jest.fn(() => ({ messages: { create: (...a) => mockMessagesCreate(...a) } }))
);

// ── config ───────────────────────────────────────────────────────────────────
let mockStagingConfig;
jest.mock('../../config/cosa.config', () => ({
  getConfig:     () => mockStagingConfig,
  _resetConfig:  () => {},
}));

// ── ssh-backend ───────────────────────────────────────────────────────────────
const mockSshIsConnected = jest.fn();
const mockSshExec        = jest.fn();
jest.mock('../../src/ssh-backend', () => ({
  isConnected: () => mockSshIsConnected(),
  exec:        (...a) => mockSshExec(...a),
  init:        jest.fn().mockResolvedValue(undefined),
  disconnect:  jest.fn(),
}));

// ── imapflow — queue-based inbox ─────────────────────────────────────────────
const mockImapInbox = [];
jest.mock('imapflow', () => ({
  ImapFlow: jest.fn().mockImplementation(() => {
    const snapshot = [...mockImapInbox];
    return {
      connect:         jest.fn().mockResolvedValue(undefined),
      getMailboxLock:  jest.fn().mockResolvedValue({ release: jest.fn() }),
      search:          jest.fn().mockResolvedValue(snapshot.map((_, i) => i + 1)),
      fetchOne:        jest.fn().mockImplementation(seq => Promise.resolve(snapshot[seq - 1])),
      messageFlagsAdd: jest.fn().mockResolvedValue(undefined),
      logout:          jest.fn().mockResolvedValue(undefined),
    };
  }),
}));

// ── nodemailer — email capture ────────────────────────────────────────────────
const mockSentEmails = [];
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({
    sendMail: jest.fn((opts) => {
      mockSentEmails.push({ ...opts });
      return Promise.resolve({ messageId: '<staging-sent@test.local>' });
    }),
  })),
}));

// ── logger ───────────────────────────────────────────────────────────────────
jest.mock('../../src/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

// ---------------------------------------------------------------------------
// Helpers + modules (required AFTER mocks)
// ---------------------------------------------------------------------------

const {
  makeStagingConfig, makeTempDataDir,
  SYSTEMCTL_HEALTHY, claudeToolUse, claudeEndTurn, makeImapMessage,
} = require('./harness');

let emailGateway;
let sessionStore;
let toolRegistry;

beforeAll(() => {
  process.env.NODE_ENV = 'staging';
  mockStagingConfig    = makeStagingConfig(makeTempDataDir());

  // Run migrations on the real temp DB
  const store = require('../../src/session-store');
  store.runMigrations();
  sessionStore = store;

  // Register tools against the real registry
  toolRegistry = require('../../src/tool-registry');
  const hc = require('../../src/tools/health-check');
  toolRegistry.register(hc.name, hc.schema, hc.handler, hc.riskLevel);

  emailGateway = require('../../src/email-gateway');

  // Wire the email gateway to the orchestrator (same as main.js)
  const { runSession } = require('../../src/orchestrator');
  emailGateway.setNewSessionHandler(async (message) => {
    await runSession({ type: 'email', source: 'operator', message });
  });
});

afterAll(() => {
  sessionStore.closeDb();
  toolRegistry._reset();
  delete process.env.NODE_ENV;
});

beforeEach(() => {
  mockImapInbox.length    = 0;
  mockSentEmails.length   = 0;
  mockSshIsConnected.mockReturnValue(true);
  mockSshExec.mockResolvedValue({
    stdout: SYSTEMCTL_HEALTHY, stderr: '', exitCode: 0,
  });
  global.fetch = jest.fn()
    .mockResolvedValueOnce({
      status: 200,
      json:   () => Promise.resolve({ status: 'ok' }),
    })
    .mockResolvedValueOnce({
      status: 200,
      json:   () => Promise.resolve({ ready: true }),
    });
  // Claude: health_check tool call → end_turn
  mockMessagesCreate
    .mockResolvedValueOnce(claudeToolUse('health_check'))
    .mockResolvedValueOnce(claudeEndTurn('Baanbaan is healthy. All checks passed.'));
});

afterEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// F-1 assertions
// ---------------------------------------------------------------------------

describe('F-1 — Operator email query returns accurate health status', () => {
  async function exerciseF1() {
    mockImapInbox.push(makeImapMessage(
      'operator@test.local',
      'Quick check',
      'Is Baanbaan running okay right now?'
    ));
    await emailGateway._runPoll();
  }

  it('creates a session row with trigger_type=email', async () => {
    await exerciseF1();
    const row = sessionStore.getDb()
      .prepare("SELECT * FROM sessions WHERE trigger_type='email' ORDER BY id DESC LIMIT 1")
      .get();
    expect(row).toBeDefined();
    expect(row.trigger_type).toBe('email');
  });

  it('closes the session with status=complete', async () => {
    await exerciseF1();
    const row = sessionStore.getDb()
      .prepare("SELECT status FROM sessions WHERE trigger_type='email' ORDER BY id DESC LIMIT 1")
      .get();
    expect(row.status).toBe('complete');
  });

  it('records the health_check tool call with status=executed', async () => {
    await exerciseF1();
    const row = sessionStore.getDb()
      .prepare("SELECT * FROM tool_calls WHERE tool_name='health_check' ORDER BY id DESC LIMIT 1")
      .get();
    expect(row).toBeDefined();
    expect(row.status).toBe('executed');
  });

  it('persists the health_check output to session.db', async () => {
    await exerciseF1();
    const row = sessionStore.getDb()
      .prepare("SELECT output FROM tool_calls WHERE tool_name='health_check' ORDER BY id DESC LIMIT 1")
      .get();
    const output = JSON.parse(row.output);
    expect(output.overall_status).toBe('healthy');
    expect(output.ssh_connected).toBe(true);
  });

  it('sends exactly one reply email to the operator', async () => {
    await exerciseF1();
    expect(mockSentEmails).toHaveLength(1);
    expect(mockSentEmails[0].to).toBe('operator@test.local');
  });

  it('reply email mentions healthy status', async () => {
    await exerciseF1();
    const text = mockSentEmails[0].text ?? mockSentEmails[0].subject ?? '';
    // The LLM response text is passed to sendEmail — assert it contains the key word
    expect(
      (mockSentEmails[0].text ?? '') + (mockSentEmails[0].subject ?? '')
    ).toMatch(/healthy/i);
  });

  it('completes within a reasonable duration (smoke-test for the 2-minute SLA)', async () => {
    const start = Date.now();
    await exerciseF1();
    expect(Date.now() - start).toBeLessThan(10_000); // well within 2-minute SLA
  });
});
