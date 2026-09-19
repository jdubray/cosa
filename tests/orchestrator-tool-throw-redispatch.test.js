'use strict';

// ---------------------------------------------------------------------------
// Regression: a tool_use whose processing REJECTS (e.g. the approval engine
// throwing after it already emailed the operator) must be dispatched exactly
// once and surface as an is_error tool_result. Before the fix, sam-pattern
// turned the rejection into present({ __error }), the NAPs re-ran with
// processingIndex still at 0, and the SAME tool_use was dispatched again —
// which is how the Sep 15 pause_store approval got a second request that hit
// the resend rate limit while the first (emailed) request was orphaned.
//
// Every persistence / side-channel dependency is stubbed so this runs without
// better-sqlite3 or the network.
// ---------------------------------------------------------------------------

const mockMessagesCreate = jest.fn();
// The orchestrator passes its live `model.messages` array, which keeps growing
// after the call — snapshot each request so assertions see what Claude saw.
const seenRequests = [];
jest.mock('@anthropic-ai/sdk', () =>
  jest.fn(() => ({
    messages: {
      create: (req) => {
        seenRequests.push(JSON.parse(JSON.stringify(req.messages)));
        return mockMessagesCreate(req);
      },
    },
  }))
);

jest.mock('../config/cosa.config', () => ({
  getConfig: () => ({
    env:       { anthropicApiKey: 'sk-ant-test' },
    appliance: { appliance_api: { api_endpoints: [] } },
  }),
}));

const mockSaveTurn = jest.fn();
jest.mock('../src/session-store', () => ({
  createSession:            jest.fn(),
  closeSession:             jest.fn(),
  saveTurn:                 (...a) => mockSaveTurn(...a),
  saveToolCall:             jest.fn().mockReturnValue(1),
  recordBlockedToolCall:    jest.fn(),
  getSessionToolCalls:      jest.fn().mockReturnValue([]),
  updateApprovalToolCallId: jest.fn(),
}));
jest.mock('../src/post-session-hook', () => ({ postSessionHook: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/security-gate', () => ({
  check:          jest.fn().mockResolvedValue({ blocked: false }),
  sanitizeOutput: (o) => (typeof o === 'string' ? o : JSON.stringify(o)),
}));
const mockRequestApproval = jest.fn();
jest.mock('../src/approval-engine', () => ({
  requiresApproval: jest.fn().mockReturnValue('once'),
  requestApproval:  (...a) => mockRequestApproval(...a),
}));
jest.mock('../src/action-verifier', () => ({ verify: jest.fn(), formatVerdict: jest.fn() }));
jest.mock('../src/tool-registry', () => ({
  getRiskLevel:           () => 'high',
  isToolPermittedForRole: () => true,
  getSchemas:             () => [],
  dispatch:               jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../src/context-builder', () => ({ build: () => 'system' }));
jest.mock('../src/memory-manager', () => ({ loadMemory: () => '' }));
jest.mock('../src/skill-store', () => ({ listCompact: () => [] }));
jest.mock('../src/context-compressor', () => ({
  needsCompression:       () => false,
  compress:               jest.fn(),
  makeCompressionAcceptor: () => () => () => {},
}));
jest.mock('../src/session-fsm', () => ({ makeReactor: () => () => () => {} }));

const { runSession } = require('../src/orchestrator');

const toolUseResponse = (id) => ({
  stop_reason: 'tool_use',
  usage:       { input_tokens: 1, output_tokens: 1 },
  content:     [{ type: 'tool_use', id, name: 'restart_appliance', input: {} }],
});
const endTurn = (text) => ({
  stop_reason: 'end_turn',
  usage:       { input_tokens: 1, output_tokens: 1 },
  content:     [{ type: 'text', text }],
});

describe('orchestrator — tool_use whose processing rejects', () => {
  beforeEach(() => { jest.clearAllMocks(); seenRequests.length = 0; });

  it('dispatches the tool_use exactly once and feeds Claude an is_error tool_result', async () => {
    mockRequestApproval.mockRejectedValueOnce(
      new TypeError("Cannot read properties of undefined (reading 'from')")
    );
    mockMessagesCreate
      .mockResolvedValueOnce(toolUseResponse('toolu_1'))
      .mockResolvedValueOnce(endTurn('done'));

    const result = await runSession({ type: 'email', source: 'owner@example.com', message: 'pause' });

    expect(result.response).toBe('done');
    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    expect(mockMessagesCreate).toHaveBeenCalledTimes(2);

    // The second Claude call must carry exactly one tool_result for toolu_1.
    const secondCallMessages = seenRequests[1];
    const toolTurn = secondCallMessages[secondCallMessages.length - 1];
    expect(toolTurn.role).toBe('user');
    expect(toolTurn.content).toHaveLength(1);
    expect(toolTurn.content[0]).toMatchObject({
      type:        'tool_result',
      tool_use_id: 'toolu_1',
      is_error:    true,
    });
    expect(toolTurn.content[0].content).toMatch(/Tool call failed/);
  });
});
