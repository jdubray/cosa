'use strict';

/**
 * Tests that postSessionHook calls recordSkillUse when an existing skill
 * matches the session's tool-call pattern, and passes the correct success flag.
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('@anthropic-ai/sdk', () =>
  jest.fn(() => ({ messages: { create: jest.fn() } }))
);

jest.mock('../config/cosa.config', () => ({
  getConfig: () => ({
    appliance: { tools: {} },
    env:       { dataDir: '/tmp/test', anthropicApiKey: 'test-key' },
  }),
}));

const mockRecordSkillUse = jest.fn();
const mockSearchSkills   = jest.fn();
const mockGetSkill       = jest.fn();
const mockCreateSkill    = jest.fn();

jest.mock('../src/skill-store', () => ({
  recordSkillUse:    (...a) => mockRecordSkillUse(...a),
  searchSkills:      (...a) => mockSearchSkills(...a),
  get:               (...a) => mockGetSkill(...a),
  create:            (...a) => mockCreateSkill(...a),
  flagDegradedSkills: jest.fn().mockReturnValue([]),
}));

jest.mock('../src/memory-manager', () => ({
  updateMemory: jest.fn(),
}));

jest.mock('../src/skill-creation-fsm', () => ({
  createSkillCreationFSM: () => ({ send: jest.fn() }),
}));

jest.mock('../src/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

const { postSessionHook } = require('../src/post-session-hook');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_TOOL_CALLS = [
  { tool_name: 'health_check',  output: { overall_status: 'healthy', checked_at: '2026-05-05T10:00:00.000Z', errors: [] } },
  { tool_name: 'backup_run',    output: { success: true, backup_files: [], completed_at: '2026-05-05T10:00:01.000Z' } },
  { tool_name: 'db_integrity',  output: null },
];

const EXISTING_SKILL = { id: 42, name: 'health-check-routine', domain: 'monitoring' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockSearchSkills.mockReturnValue([]);
  mockGetSkill.mockReturnValue(null);
  mockCreateSkill.mockReturnValue(EXISTING_SKILL);
});

describe('postSessionHook — skill use tracking', () => {
  test('calls recordSkillUse with success=true when skill match found and status=complete', async () => {
    mockSearchSkills.mockReturnValue([EXISTING_SKILL]);

    await postSessionHook({
      sessionId:  'sess-track-001',
      trigger:    { type: 'cron', source: 'health-cron' },
      toolCalls:  BASE_TOOL_CALLS,
      finalText:  'Appliance is healthy.',
      status:     'complete',
    });

    expect(mockRecordSkillUse).toHaveBeenCalledTimes(1);
    expect(mockRecordSkillUse).toHaveBeenCalledWith(
      EXISTING_SKILL.id,
      'sess-track-001',
      true
    );
  });

  test('calls recordSkillUse with success=false when status is not complete', async () => {
    mockSearchSkills.mockReturnValue([EXISTING_SKILL]);

    await postSessionHook({
      sessionId:  'sess-track-002',
      trigger:    { type: 'cron', source: 'health-cron' },
      toolCalls:  BASE_TOOL_CALLS,
      finalText:  'Something went wrong.',
      status:     'error',
    });

    expect(mockRecordSkillUse).toHaveBeenCalledWith(
      EXISTING_SKILL.id,
      'sess-track-002',
      false
    );
  });

  test('does NOT call recordSkillUse when no matching skill exists', async () => {
    mockSearchSkills.mockReturnValue([]);  // no match

    await postSessionHook({
      sessionId:  'sess-track-003',
      trigger:    { type: 'cron', source: 'health-cron' },
      toolCalls:  BASE_TOOL_CALLS,
      finalText:  'Done.',
      status:     'complete',
    });

    expect(mockRecordSkillUse).not.toHaveBeenCalled();
  });

  test('does NOT call recordSkillUse for email-triggered sessions (skill creation skipped)', async () => {
    mockSearchSkills.mockReturnValue([EXISTING_SKILL]);

    await postSessionHook({
      sessionId:  'sess-track-004',
      trigger:    { type: 'email', source: 'operator' },
      toolCalls:  BASE_TOOL_CALLS,
      finalText:  'Done.',
      status:     'complete',
    });

    // email trigger exits before searching, so recordSkillUse never fires
    expect(mockRecordSkillUse).not.toHaveBeenCalled();
  });

  test('does NOT call recordSkillUse when tool call count is below minimum', async () => {
    mockSearchSkills.mockReturnValue([EXISTING_SKILL]);

    await postSessionHook({
      sessionId:  'sess-track-005',
      trigger:    { type: 'cron', source: 'health-cron' },
      toolCalls:  [{ tool_name: 'health_check', output: null }],  // only 1 call
      finalText:  'Done.',
      status:     'complete',
    });

    expect(mockRecordSkillUse).not.toHaveBeenCalled();
  });

  test('swallows recordSkillUse errors and continues normally', async () => {
    mockSearchSkills.mockReturnValue([EXISTING_SKILL]);
    mockRecordSkillUse.mockImplementation(() => { throw new Error('DB locked'); });

    await expect(postSessionHook({
      sessionId:  'sess-track-006',
      trigger:    { type: 'cron', source: 'health-cron' },
      toolCalls:  BASE_TOOL_CALLS,
      finalText:  'Done.',
      status:     'complete',
    })).resolves.toBeUndefined();
  });
});
