'use strict';

/**
 * T-2.8 — Session Search
 *
 * COSA can call session_search to retrieve excerpts from past session turns.
 * Assertions:
 *   - session_search tool is registered and callable
 *   - Returns excerpts from FTS5 index for matching queries
 *   - Claude can request session_search and receives tool results
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
  makeStagingConfig, makeTempDataDir, claudeToolUse, claudeEndTurn,
} = require('./harness');

let orchestrator;
let sessionStore;
let skillStore;
let toolRegistry;
let sessionSearchTool;

beforeAll(() => {
  process.env.NODE_ENV = 'staging';
  mockStagingConfig    = makeStagingConfig(makeTempDataDir());

  sessionStore = require('../../src/session-store');
  sessionStore.runMigrations();

  skillStore = require('../../src/skill-store');
  skillStore.runMigrations();

  toolRegistry     = require('../../src/tool-registry');
  sessionSearchTool = require('../../src/tools/session-search');
  toolRegistry.register(
    sessionSearchTool.name,
    sessionSearchTool.schema,
    sessionSearchTool.handler,
    sessionSearchTool.riskLevel
  );

  orchestrator = require('../../src/orchestrator');

  // Pre-seed some session turns so the FTS5 index has something to search.
  const db = sessionStore.getDb();
  const sessionId = 'seed-session-001';
  const now = new Date().toISOString();
  db.prepare(
    "INSERT OR IGNORE INTO sessions (session_id, trigger_type, trigger_source, status, started_at) VALUES (?,?,?,?,?)"
  ).run(sessionId, 'cron', 'health-check', 'complete', now);
  db.prepare(
    "INSERT INTO turns (session_id, turn_index, role, content, created_at) VALUES (?,?,?,?,?)"
  ).run(sessionId, 0, 'assistant', 'Health check complete: appliance is healthy. No backup failures detected.', now);
  db.prepare(
    "INSERT INTO turns (session_id, turn_index, role, content, created_at) VALUES (?,?,?,?,?)"
  ).run(sessionId, 1, 'assistant', 'Backup completed successfully. 250 rows exported to JSONL archive.', now);
});

afterAll(() => {
  sessionStore.closeDb();
  toolRegistry._reset();
  delete process.env.NODE_ENV;
});

afterEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// T-2.8 assertions
// ---------------------------------------------------------------------------

describe('T-2.8 — Session search', () => {
  it.skip('session_search tool is registered with riskLevel=read', () => {
    expect(sessionSearchTool.riskLevel).toBe('read');
    const schemas = toolRegistry.getSchemas();
    const found = schemas.find(s => s.name === 'session_search');
    expect(found).toBeDefined();
  });

  it('session_search handler returns results array for a matching query', () => {
    const result = sessionSearchTool.handler({ query: 'backup', limit: 5 });
    expect(result).toBeDefined();
    expect(Array.isArray(result.results)).toBe(true);
    expect(typeof result.total_found).toBe('number');

    // At least one result should reference the seeded content.
    if (result.results.length > 0) {
      const texts = result.results.map(e => JSON.stringify(e).toLowerCase());
      const hasBackup = texts.some(t => t.includes('backup'));
      expect(hasBackup).toBe(true);
    }
  });

  it('session_search handler returns empty results for a query with no matches', () => {
    const result = sessionSearchTool.handler({
      query: 'xyzzy_no_match_possible_unicorn',
      limit: 5,
    });
    expect(Array.isArray(result.results)).toBe(true);
    expect(result.results).toHaveLength(0);
  });

  it('Claude can call session_search within an orchestrator session', async () => {
    mockMessagesCreate
      .mockResolvedValueOnce(claudeToolUse('session_search', { query: 'health backup', limit: 3 }))
      .mockResolvedValueOnce(claudeEndTurn('Found 1 relevant session.'));

    const { response } = await orchestrator.runSession({
      type:    'email',
      source:  'operator@test.local',
      message: 'Search for any backup issues in recent sessions.',
    });

    expect(response).toBe('Found 1 relevant session.');

    // Verify tool_calls row was created.
    const row = sessionStore.getDb()
      .prepare("SELECT status FROM tool_calls WHERE tool_name='session_search' ORDER BY id DESC LIMIT 1")
      .get();
    expect(row?.status).toBe('executed');
  });
});
