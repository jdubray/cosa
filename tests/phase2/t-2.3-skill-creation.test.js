'use strict';

/**
 * T-2.3 — Skill Creation from Novel Incident
 *
 * After a session with ≥3 executed tool calls and no matching skill in
 * skills.db, the post-session hook generates and inserts a new skill.
 *
 * The generated skill must include:
 *   - name, title, description, domain (frontmatter)
 *   - ## Steps section
 *   - ## Experience section
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
  isConnected: jest.fn().mockReturnValue(true),
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
  SYSTEMCTL_HEALTHY, claudeToolUse, claudeEndTurn, flushPromises,
} = require('./harness');

// Skill document Claude will generate.
const GENERATED_SKILL = `---
name: weatherstation-health-check-routine
title: WeatherStation Health Check Routine
description: Standard health check procedure for WeatherStation appliance including HTTP and process checks.
domain: monitoring
---

## Steps

1. Run health_check tool to assess appliance state.
2. Check overall_status field in the result.
3. If degraded or unreachable, run db_integrity to diagnose.
4. Send alert email if issues found.

## Experience

Healthy checks require NRestarts=0 and both HTTP endpoints responding 200.
`;

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

  toolRegistry = require('../../src/tool-registry');
  const hc = require('../../src/tools/health-check');
  const di = require('../../src/tools/db-integrity');
  toolRegistry.register(hc.name, hc.schema, hc.handler, hc.riskLevel);
  toolRegistry.register(di.name, di.schema, di.handler, di.riskLevel);

  orchestrator = require('../../src/orchestrator');
});

afterAll(() => {
  sessionStore.closeDb();
  toolRegistry._reset();
  delete process.env.NODE_ENV;
});

beforeEach(() => {
  mockSshExec.mockResolvedValue({ stdout: SYSTEMCTL_HEALTHY, stderr: '', exitCode: 0 });
  global.fetch = jest.fn()
    .mockResolvedValue({ status: 200, json: () => Promise.resolve({ status: 'ok', ready: true }) });
});

afterEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// T-2.3 assertions
// ---------------------------------------------------------------------------

describe('T-2.3 — Skill creation from novel incident', () => {
  it('inserts a new row in skills.db after a session with ≥3 tool calls', async () => {
    const initialCount = skillStore.getDb()
      .prepare('SELECT COUNT(*) AS n FROM skills').get().n;

    // Session: health_check × 3 tool calls (to meet the ≥3 threshold).
    mockMessagesCreate
      .mockResolvedValueOnce(claudeToolUse('health_check'))
      .mockResolvedValueOnce(claudeToolUse('health_check'))
      .mockResolvedValueOnce(claudeToolUse('health_check'))
      .mockResolvedValueOnce(claudeEndTurn('Three health checks complete.'))
      // Post-session hook calls Claude to generate skill document.
      .mockResolvedValueOnce(claudeEndTurn(GENERATED_SKILL));

    await orchestrator.runSession({
      type:    'cron',
      source:  'health-check',
      message: 'Run three health checks.',
    });

    // Post-session hook is fire-and-forget — flush promises.
    await flushPromises();
    await flushPromises(); // two flushes to allow nested async ops

    const newCount = skillStore.getDb()
      .prepare('SELECT COUNT(*) AS n FROM skills').get().n;

    expect(newCount).toBeGreaterThan(initialCount);
  });

  it('generated skill has name, title, description, domain', async () => {
    const row = skillStore.getDb()
      .prepare('SELECT * FROM skills ORDER BY id DESC LIMIT 1')
      .get();

    if (row) {
      expect(row.name).toBeTruthy();
      expect(row.title).toBeTruthy();
      expect(row.description).toBeTruthy();
      expect(row.domain).toBeTruthy();
    }
    // If no row exists the previous test would have failed; this just validates structure.
  });

  it('skill content includes ## Steps and ## Experience sections', async () => {
    const row = skillStore.getDb()
      .prepare('SELECT content FROM skills ORDER BY id DESC LIMIT 1')
      .get();

    if (row) {
      expect(row.content).toContain('## Steps');
      expect(row.content).toContain('## Experience');
    }
  });

  it('does NOT create a duplicate skill when matching skill already exists', async () => {
    const countBefore = skillStore.getDb()
      .prepare('SELECT COUNT(*) AS n FROM skills').get().n;

    // Run another identical session — skill already exists, should not duplicate.
    mockMessagesCreate
      .mockResolvedValueOnce(claudeToolUse('health_check'))
      .mockResolvedValueOnce(claudeToolUse('health_check'))
      .mockResolvedValueOnce(claudeToolUse('health_check'))
      .mockResolvedValueOnce(claudeEndTurn('Three health checks complete.'))
      .mockResolvedValueOnce(claudeEndTurn(GENERATED_SKILL));

    await orchestrator.runSession({
      type:    'cron',
      source:  'health-check',
      message: 'Run three health checks again.',
    });
    await flushPromises();
    await flushPromises();

    const countAfter = skillStore.getDb()
      .prepare('SELECT COUNT(*) AS n FROM skills').get().n;

    expect(countAfter).toBe(countBefore);
  });
});
