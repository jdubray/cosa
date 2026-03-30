'use strict';

/**
 * T-2.4 — Skill Reuse
 *
 * When a skill exists in skills.db, the orchestrator injects it into Layer 3
 * of the system prompt (compact skill index) via `skillStore.listCompact()`.
 * The skill name and description appear in the cached system block.
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
  makeStagingConfig, makeTempDataDir, claudeEndTurn,
} = require('./harness');

let orchestrator;
let sessionStore;
let skillStore;
let toolRegistry;

// Capture the system prompt array sent on the first messages.create call.
let capturedSystemBlocks;

beforeAll(() => {
  process.env.NODE_ENV = 'staging';
  mockStagingConfig    = makeStagingConfig(makeTempDataDir());

  sessionStore = require('../../src/session-store');
  sessionStore.runMigrations();

  skillStore = require('../../src/skill-store');
  skillStore.runMigrations();

  // Pre-seed a skill so it appears in listCompact() output.
  skillStore.create({
    name:        'health-check-routine',
    title:       'Health Check Routine',
    description: 'Standard health check for appliance monitoring.',
    domain:      'monitoring',
    content: `---
name: health-check-routine
title: Health Check Routine
description: Standard health check for appliance monitoring.
domain: monitoring
---

## Steps

1. Run health_check tool.
2. Evaluate overall_status.

## Experience

Healthy = NRestarts=0.
`,
  });

  toolRegistry = require('../../src/tool-registry');
  const hc = require('../../src/tools/health-check');
  toolRegistry.register(hc.name, hc.schema, hc.handler, hc.riskLevel);

  orchestrator = require('../../src/orchestrator');
});

afterAll(() => {
  sessionStore.closeDb();
  toolRegistry._reset();
  delete process.env.NODE_ENV;
});

beforeEach(() => {
  capturedSystemBlocks = null;
  mockMessagesCreate.mockImplementation(async (params) => {
    if (!capturedSystemBlocks) {
      capturedSystemBlocks = params.system;
    }
    return claudeEndTurn('Health check done.');
  });
});

afterEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// T-2.4 assertions
// ---------------------------------------------------------------------------

describe('T-2.4 — Skill reuse', () => {
  it('skill name appears in Layer 3 of the system prompt (compact index)', async () => {
    await orchestrator.runSession({
      type:    'cron',
      source:  'health-check',
      message: 'Run health_check and report status.',
    });

    expect(capturedSystemBlocks).toBeDefined();

    // Layer 3 is embedded inside the first cached block (blocks[0].text).
    // It contains: "health-check-routine (monitoring): Standard health check…"
    const cachedBlock = Array.isArray(capturedSystemBlocks)
      ? capturedSystemBlocks[0]?.text ?? ''
      : String(capturedSystemBlocks);

    expect(cachedBlock).toContain('health-check-routine');
  });

  it('skill description is included in the system prompt', async () => {
    await orchestrator.runSession({
      type:    'cron',
      source:  'health-check',
      message: 'Run health_check and report status.',
    });

    const cachedBlock = Array.isArray(capturedSystemBlocks)
      ? capturedSystemBlocks[0]?.text ?? ''
      : String(capturedSystemBlocks);

    expect(cachedBlock).toContain('Standard health check for appliance monitoring');
  });

  it('Layer 3 block has cache_control: ephemeral (skills are cached)', async () => {
    await orchestrator.runSession({
      type:    'cron',
      source:  'health-check',
      message: 'Run health_check and report status.',
    });

    const firstBlock = Array.isArray(capturedSystemBlocks)
      ? capturedSystemBlocks[0]
      : null;

    if (firstBlock) {
      expect(firstBlock.cache_control?.type).toBe('ephemeral');
    }
  });

  it('skillStore.listCompact() includes the seeded skill', () => {
    const compact = skillStore.listCompact();
    expect(compact).toContain('health-check-routine');
    expect(compact).toContain('monitoring');
  });
});
