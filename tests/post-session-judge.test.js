'use strict';

// ---------------------------------------------------------------------------
// postSessionHook + LLM-as-judge integration (Verification Loop spec, Layer B).
// Fully mocked — no DB, no network. Verifies the judge runs only for action
// sessions with mutating tools, gates skill authoring on the verdict, persists
// it, and alerts on a silent failure.
// ---------------------------------------------------------------------------

const mockGenCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () =>
  jest.fn(() => ({ messages: { create: (...a) => mockGenCreate(...a) } }))
);

jest.mock('../config/cosa.config', () => ({
  getConfig: () => ({
    appliance: {
      tools: {},
      operator: { email: 'ops@test.local' },
      appliance: { name: 'TestPOS' },
      verification: { judge: { enabled: true, min_mutating_tools: 1, alert_on_unresolved: true } },
    },
    env: { dataDir: '/tmp/test', anthropicApiKey: 'test-key' },
  }),
}));

const mockRecordSkillUse = jest.fn();
const mockSearchSkills   = jest.fn();
const mockGetSkill       = jest.fn();
const mockCreateSkill    = jest.fn();
jest.mock('../src/skill-store', () => ({
  recordSkillUse:     (...a) => mockRecordSkillUse(...a),
  searchSkills:       (...a) => mockSearchSkills(...a),
  get:                (...a) => mockGetSkill(...a),
  create:             (...a) => mockCreateSkill(...a),
  flagDegradedSkills: jest.fn().mockReturnValue([]),
}));

jest.mock('../src/memory-manager', () => ({ updateMemory: jest.fn() }));
jest.mock('../src/skill-creation-fsm', () => ({ createSkillCreationFSM: () => ({ send: jest.fn() }) }));
jest.mock('../src/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const mockGetRiskLevel = jest.fn();
jest.mock('../src/tool-registry', () => ({ getRiskLevel: (...a) => mockGetRiskLevel(...a) }));

const mockJudge = jest.fn();
jest.mock('../src/session-judge', () => ({ judgeSession: (...a) => mockJudge(...a) }));

const mockRecordJudgeVerdict = jest.fn();
const mockCreateAlert        = jest.fn();
jest.mock('../src/session-store', () => ({
  recordJudgeVerdict: (...a) => mockRecordJudgeVerdict(...a),
  createAlert:        (...a) => mockCreateAlert(...a),
}));

const mockSendEmail = jest.fn();
jest.mock('../src/email-gateway', () => ({ sendEmail: (...a) => mockSendEmail(...a) }));

const { postSessionHook } = require('../src/post-session-hook');

// 3 calls (meets min_tool_calls_for_skill=3); one is mutating (appliance_api_call).
const MUTATING_CALLS = [
  { tool_name: 'appliance_api_call', input: { endpoint_name: 'pause_store' }, output: { status: 'ok' } },
  { tool_name: 'health_check', input: {}, output: { overall_status: 'healthy' } },
  { tool_name: 'db_query', input: {}, output: null },
];
const READ_ONLY_CALLS = [
  { tool_name: 'health_check', input: {}, output: { overall_status: 'healthy' } },
  { tool_name: 'db_query', input: {}, output: null },
  { tool_name: 'db_integrity', input: {}, output: null },
];

const VALID_SKILL_MD = [
  '---', 'name: paused-store-recovery', 'title: Paused Store Recovery',
  'description: Confirms a store pause took effect', 'domain: maintenance', '---',
  '', '## Steps', '1. Pause the store', '## Experience', 'none',
].join('\n');

const EXISTING_SKILL = { id: 42, name: 'pause-routine', domain: 'maintenance' };

beforeEach(() => {
  jest.clearAllMocks();
  mockSearchSkills.mockReturnValue([]);
  mockGetSkill.mockReturnValue(null);
  mockCreateSkill.mockReturnValue(EXISTING_SKILL);
  // Mutating risk for appliance_api_call; everything else read-only.
  mockGetRiskLevel.mockImplementation(name => (name === 'appliance_api_call' ? 'dynamic' : 'read'));
  // Skill generation returns a valid document when reached.
  mockGenCreate.mockResolvedValue({ content: [{ type: 'text', text: VALID_SKILL_MD }] });
});

const run = (over = {}) => postSessionHook({
  sessionId: 's-judge', trigger: { type: 'cron', source: 'watcher', message: 'pause the store' },
  toolCalls: MUTATING_CALLS, finalText: 'Store paused.', status: 'complete', ...over,
});

describe('postSessionHook — Layer-B judge', () => {
  it('AC15: does not judge an email-triggered session', async () => {
    await run({ trigger: { type: 'email', source: 'operator', message: 'hi' } });
    expect(mockJudge).not.toHaveBeenCalled();
  });

  it('AC15: does not judge a session with no mutating tools', async () => {
    await run({ toolCalls: READ_ONLY_CALLS });
    expect(mockJudge).not.toHaveBeenCalled();
  });

  it('judges an action session that ran a mutating tool', async () => {
    mockJudge.mockResolvedValue({ verdict: 'resolved', confidence: 0.9, reason: 'ok' });
    await run();
    expect(mockJudge).toHaveBeenCalledTimes(1);
    expect(mockJudge.mock.calls[0][0]).toMatchObject({ objective: 'pause the store' });
  });

  it('AC16: authors a skill when judged resolved (no existing skill)', async () => {
    mockJudge.mockResolvedValue({ verdict: 'resolved', confidence: 0.95, reason: 'confirmed' });
    await run();
    expect(mockGenCreate).toHaveBeenCalled();      // generation was attempted
    expect(mockCreateSkill).toHaveBeenCalledTimes(1);
  });

  it('AC16: does NOT author a skill when judged unresolved, even on clean completion', async () => {
    mockJudge.mockResolvedValue({ verdict: 'unresolved', confidence: 0.8, reason: 'still degraded' });
    await run({ status: 'complete' });
    expect(mockGenCreate).not.toHaveBeenCalled();
    expect(mockCreateSkill).not.toHaveBeenCalled();
  });

  it('AC16: does NOT author a skill when judged uncertain', async () => {
    mockJudge.mockResolvedValue({ verdict: 'uncertain', confidence: 0.3, reason: 'no evidence' });
    await run();
    expect(mockCreateSkill).not.toHaveBeenCalled();
  });

  it('AC17: recordSkillUse success reflects the verdict (resolved → true)', async () => {
    mockSearchSkills.mockReturnValue([EXISTING_SKILL]);
    mockJudge.mockResolvedValue({ verdict: 'resolved', confidence: 0.9, reason: 'ok' });
    await run();
    expect(mockRecordSkillUse).toHaveBeenCalledWith(EXISTING_SKILL.id, 's-judge', true);
  });

  it('AC17: recordSkillUse success reflects the verdict (unresolved → false)', async () => {
    mockSearchSkills.mockReturnValue([EXISTING_SKILL]);
    mockJudge.mockResolvedValue({ verdict: 'unresolved', confidence: 0.7, reason: 'nope' });
    await run();
    expect(mockRecordSkillUse).toHaveBeenCalledWith(EXISTING_SKILL.id, 's-judge', false);
  });

  it('AC18: persists the verdict and alerts the operator on unresolved', async () => {
    mockJudge.mockResolvedValue({ verdict: 'unresolved', confidence: 0.82, reason: 'health degraded' });
    await run();
    expect(mockRecordJudgeVerdict).toHaveBeenCalledWith('s-judge', 'unresolved:0.82');
    expect(mockCreateAlert).toHaveBeenCalledTimes(1);
    expect(mockCreateAlert.mock.calls[0][0]).toMatchObject({ category: 'unresolved_action', severity: 'high' });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it('does not alert when the verdict is resolved', async () => {
    mockJudge.mockResolvedValue({ verdict: 'resolved', confidence: 0.9, reason: 'ok' });
    await run();
    expect(mockCreateAlert).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockRecordJudgeVerdict).toHaveBeenCalledWith('s-judge', 'resolved:0.9');
  });
});
