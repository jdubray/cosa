'use strict';

/**
 * T-2.6 — Context Compression
 *
 * When a session accumulates > maxTurnsBeforeCompress messages,
 * the context compressor calls Haiku to summarise the middle turns,
 * and the resulting message array length does not exceed protectFirstN +
 * 1 (summary) + protectLastN.
 *
 * Default config: maxTurnsBeforeCompress=12, protectFirstN=3, protectLastN=4
 * → compressed length = 3 + 1 + 4 = 8.
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

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({
    sendMail: jest.fn(() => Promise.resolve({ messageId: '<sent@test>' })),
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

const HAIKU_SUMMARY = 'Context summary: 6 prior turns compressed. Health checks were healthy.';

let sessionStore;
let skillStore;
let toolRegistry;
let contextCompressor;

// Track the messages array length seen at the point of each Claude call.
const capturedMessageLengths = [];

beforeAll(() => {
  process.env.NODE_ENV = 'staging';

  // Use a config with a low maxTurnsBeforeCompress to trigger compression quickly.
  const base = makeStagingConfig(makeTempDataDir());
  base.appliance.context_compression = {
    enabled:                true,
    max_turns_before_compress: 4,  // very low for testing
    protect_first_n:           1,
    protect_last_n:            2,
    compression_model:         'claude-haiku-4-5-20251001',
  };
  mockStagingConfig = base;

  sessionStore = require('../../src/session-store');
  sessionStore.runMigrations();

  skillStore = require('../../src/skill-store');
  skillStore.runMigrations();

  toolRegistry = require('../../src/tool-registry');
  // Register a minimal no-op tool that returns quickly.
  toolRegistry.register(
    'health_check',
    require('../../src/tools/health-check').schema,
    require('../../src/tools/health-check').handler,
    require('../../src/tools/health-check').riskLevel
  );

  contextCompressor = require('../../src/context-compressor');
});

afterAll(() => {
  sessionStore.closeDb();
  toolRegistry._reset();
  delete process.env.NODE_ENV;
});

afterEach(() => {
  capturedMessageLengths.length = 0;
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// T-2.6 assertions
// ---------------------------------------------------------------------------

describe('T-2.6 — Context compression', () => {
  it('needsCompression returns false when messages.length <= threshold', () => {
    const msgs = Array.from({ length: 4 }, (_, i) => ({ role: 'user', content: `msg ${i}` }));
    expect(contextCompressor.needsCompression(msgs)).toBe(false);
  });

  it('needsCompression returns true when messages.length exceeds threshold', () => {
    const msgs = Array.from({ length: 5 }, (_, i) => ({ role: 'user', content: `msg ${i}` }));
    expect(contextCompressor.needsCompression(msgs)).toBe(true);
  });

  it('compress() returns an array shorter than the input', async () => {
    // 8 messages: protectFirst=1 + middle=5 + protectLast=2.
    const msgs = Array.from({ length: 8 }, (_, i) => ({
      role:    i % 2 === 0 ? 'user' : 'assistant',
      content: `turn ${i}`,
    }));

    // Haiku returns a summary.
    mockMessagesCreate.mockResolvedValueOnce(claudeEndTurn(HAIKU_SUMMARY));

    const sessionId = 'compression-test-session';
    sessionStore.getDb().prepare(
      "INSERT OR IGNORE INTO sessions (session_id, trigger_type, trigger_source, status, started_at) VALUES (?,?,?,?,?)"
    ).run(sessionId, 'test', 'test', 'running', new Date().toISOString());

    const compressed = await contextCompressor.compress(msgs, sessionId);

    expect(compressed.length).toBeLessThan(msgs.length);
    // Expected: protectFirst(1) + summary(1) + protectLast(2) = 4
    expect(compressed.length).toBe(4);
  });

  it('compressed message array contains the summary prefix', async () => {
    const msgs = Array.from({ length: 8 }, (_, i) => ({
      role:    i % 2 === 0 ? 'user' : 'assistant',
      content: `turn ${i}`,
    }));

    mockMessagesCreate.mockResolvedValueOnce(claudeEndTurn(HAIKU_SUMMARY));

    const sessionId = 'compression-prefix-test';
    sessionStore.getDb().prepare(
      "INSERT OR IGNORE INTO sessions (session_id, trigger_type, trigger_source, status, started_at) VALUES (?,?,?,?,?)"
    ).run(sessionId, 'test', 'test', 'running', new Date().toISOString());

    const compressed = await contextCompressor.compress(msgs, sessionId);

    const summaryMsg = compressed.find(m => m.content?.includes('[Context summary'));
    expect(summaryMsg).toBeDefined();
  });

  it('session is marked as compressed in the database', async () => {
    const msgs = Array.from({ length: 8 }, (_, i) => ({
      role:    i % 2 === 0 ? 'user' : 'assistant',
      content: `turn ${i}`,
    }));

    mockMessagesCreate.mockResolvedValueOnce(claudeEndTurn(HAIKU_SUMMARY));

    const sessionId = 'compression-mark-test';
    sessionStore.getDb().prepare(
      "INSERT OR IGNORE INTO sessions (session_id, trigger_type, trigger_source, status, started_at) VALUES (?,?,?,?,?)"
    ).run(sessionId, 'test', 'test', 'running', new Date().toISOString());

    await contextCompressor.compress(msgs, sessionId);

    // markSessionCompressed sets is_compressed = 1 (dedicated column, not parent_id).
    const row = sessionStore.getDb()
      .prepare('SELECT is_compressed FROM sessions WHERE session_id=?')
      .get(sessionId);
    expect(row?.is_compressed).toBe(1);
  });
});
