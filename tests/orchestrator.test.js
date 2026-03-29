'use strict';

// ---------------------------------------------------------------------------
// Mocks — `mock` prefix exempts from Jest's hoisting TDZ rule.
// ---------------------------------------------------------------------------

// ── @anthropic-ai/sdk ────────────────────────────────────────────────────────
const mockMessagesCreate = jest.fn();

jest.mock('@anthropic-ai/sdk', () =>
  jest.fn(() => ({
    messages: { create: (...a) => mockMessagesCreate(...a) },
  }))
);

// ── config ───────────────────────────────────────────────────────────────────
const mockGetConfig = jest.fn();

jest.mock('../config/cosa.config', () => ({
  getConfig: (...a) => mockGetConfig(...a),
}));

// ── session-store ────────────────────────────────────────────────────────────
const mockCreateSession        = jest.fn();
const mockCloseSession         = jest.fn();
const mockSaveTurn             = jest.fn();
const mockSaveToolCall         = jest.fn();
const mockRecordBlockedToolCall = jest.fn();

jest.mock('../src/session-store', () => ({
  createSession:         (...a) => mockCreateSession(...a),
  closeSession:          (...a) => mockCloseSession(...a),
  saveTurn:              (...a) => mockSaveTurn(...a),
  saveToolCall:          (...a) => mockSaveToolCall(...a),
  recordBlockedToolCall: (...a) => mockRecordBlockedToolCall(...a),
}));

// ── security-gate ─────────────────────────────────────────────────────────────
const mockCheck         = jest.fn();
const mockSanitizeOutput = jest.fn();

jest.mock('../src/security-gate', () => ({
  check:          (...a) => mockCheck(...a),
  sanitizeOutput: (...a) => mockSanitizeOutput(...a),
}));

// ── approval-engine ───────────────────────────────────────────────────────────
const mockRequiresApproval = jest.fn();
const mockRequestApproval  = jest.fn();

jest.mock('../src/approval-engine', () => ({
  requiresApproval: (...a) => mockRequiresApproval(...a),
  requestApproval:  (...a) => mockRequestApproval(...a),
}));

// ── tool-registry ────────────────────────────────────────────────────────────
const mockGetSchemas  = jest.fn();
const mockDispatch    = jest.fn();
const mockGetRiskLevel = jest.fn();

jest.mock('../src/tool-registry', () => ({
  getSchemas:   (...a) => mockGetSchemas(...a),
  dispatch:     (...a) => mockDispatch(...a),
  getRiskLevel: (...a) => mockGetRiskLevel(...a),
}));

// ── context-builder ───────────────────────────────────────────────────────────
const mockBuild = jest.fn();

jest.mock('../src/context-builder', () => ({
  build: (...a) => mockBuild(...a),
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

const { runSession } = require('../src/orchestrator');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_CONFIG = {
  env: {
    anthropicApiKey: 'sk-ant-test',
  },
};

const TRIGGER = {
  type:    'cron',
  source:  'health-check',
  message: 'Run the health_check tool and report the status.',
};

const TOOL_SCHEMAS = [
  {
    name:         'health_check',
    description:  'Run a health check',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

const HEALTH_RESULT = {
  overall_status: 'healthy',
  ssh_connected:  true,
  errors:         [],
  checked_at:     '2024-01-15T10:00:00.000Z',
};

/** Build a Claude end_turn response. */
function makeEndTurnResponse(text = 'All systems healthy.') {
  return {
    id:          'msg-end',
    type:        'message',
    role:        'assistant',
    content:     [{ type: 'text', text }],
    model:       'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    usage:       { input_tokens: 100, output_tokens: 50 },
  };
}

/** Build a Claude tool_use response with one or more tool calls. */
function makeToolUseResponse(calls = [{ name: 'health_check', input: {} }]) {
  return {
    id:          'msg-tool',
    type:        'message',
    role:        'assistant',
    content:     calls.map((c, i) => ({
      type:  'tool_use',
      id:    `toolu_${i}`,
      name:  c.name,
      input: c.input,
    })),
    model:       'claude-sonnet-4-6',
    stop_reason: 'tool_use',
    usage:       { input_tokens: 80, output_tokens: 30 },
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockGetConfig.mockReturnValue(BASE_CONFIG);
  mockGetSchemas.mockReturnValue(TOOL_SCHEMAS);
  mockGetRiskLevel.mockReturnValue('read');
  mockCheck.mockReturnValue({ blocked: false });
  mockRequiresApproval.mockReturnValue('auto');
  mockDispatch.mockResolvedValue(HEALTH_RESULT);
  mockSanitizeOutput.mockImplementation(v =>
    typeof v === 'string' ? v : JSON.stringify(v)
  );
  mockSaveToolCall.mockReturnValue(1);
  mockRecordBlockedToolCall.mockReturnValue(1);
  mockBuild.mockReturnValue('COSA system prompt');
  // Default: one tool use then end_turn
  mockMessagesCreate
    .mockResolvedValueOnce(makeToolUseResponse())
    .mockResolvedValueOnce(makeEndTurnResponse());
});

afterEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// AC1 — Session creation, system prompt, and initial Claude API call
// ---------------------------------------------------------------------------

describe('AC1 — session creation and initial Claude call', () => {
  it('creates a session record with the trigger type and source', async () => {
    await runSession(TRIGGER);
    expect(mockCreateSession).toHaveBeenCalledWith(
      expect.any(String),
      { type: TRIGGER.type, source: TRIGGER.source }
    );
  });

  it('returns a session_id matching the created session', async () => {
    const result = await runSession(TRIGGER);
    const [sessionId] = mockCreateSession.mock.calls[0];
    expect(result.session_id).toBe(sessionId);
  });

  it('saves the user trigger message as the first turn', async () => {
    await runSession(TRIGGER);
    expect(mockSaveTurn).toHaveBeenCalledWith(
      expect.any(String),
      'user',
      TRIGGER.message,
      null,
      null
    );
  });

  it('calls messages.create with model claude-sonnet-4-6', async () => {
    await runSession(TRIGGER);
    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-sonnet-4-6' })
    );
  });

  it('calls messages.create with the registered tool schemas', async () => {
    await runSession(TRIGGER);
    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ tools: TOOL_SCHEMAS })
    );
  });

  it('includes the trigger message as the first user message', async () => {
    await runSession(TRIGGER);
    const [callArgs] = mockMessagesCreate.mock.calls[0];
    expect(callArgs.messages[0]).toEqual({
      role:    'user',
      content: TRIGGER.message,
    });
  });

  it('passes a non-empty system prompt to Claude', async () => {
    await runSession(TRIGGER);
    const [callArgs] = mockMessagesCreate.mock.calls[0];
    expect(typeof callArgs.system).toBe('string');
    expect(callArgs.system.length).toBeGreaterThan(0);
  });

  it('constructs the Anthropic client with the API key from config', async () => {
    const Anthropic = require('@anthropic-ai/sdk');
    await runSession(TRIGGER);
    expect(Anthropic).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: BASE_CONFIG.env.anthropicApiKey })
    );
  });
});

// ---------------------------------------------------------------------------
// AC2 — Security gate check before each tool execution
// ---------------------------------------------------------------------------

describe('AC2 — security gate runs before every tool call', () => {
  it('calls securityGate.check for each tool use block', async () => {
    await runSession(TRIGGER);
    expect(mockCheck).toHaveBeenCalledTimes(1);
  });

  it('passes tool_name and input to securityGate.check', async () => {
    await runSession(TRIGGER);
    expect(mockCheck).toHaveBeenCalledWith(
      expect.objectContaining({ tool_name: 'health_check', input: {} })
    );
  });

  it('checks every tool when multiple tools are called in one response', async () => {
    mockMessagesCreate
      .mockResolvedValueOnce(
        makeToolUseResponse([
          { name: 'health_check', input: {} },
          { name: 'db_query',     input: { query: 'SELECT 1' } },
        ])
      )
      .mockResolvedValueOnce(makeEndTurnResponse());

    await runSession(TRIGGER);
    expect(mockCheck).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// AC3 — Blocked tool calls are logged and error returned to Claude
// ---------------------------------------------------------------------------

describe('AC3 — blocked tool calls', () => {
  beforeEach(() => {
    mockCheck.mockReturnValue({ blocked: true, reason: 'Recursive delete', pattern: 'rm\\s+-rf' });
    mockMessagesCreate
      .mockReset()
      .mockResolvedValueOnce(makeToolUseResponse([{ name: 'health_check', input: { cmd: 'rm -rf /' } }]))
      .mockResolvedValueOnce(makeEndTurnResponse('Blocked.'));
  });

  it('calls recordBlockedToolCall with reason when security gate blocks', async () => {
    await runSession(TRIGGER);
    expect(mockRecordBlockedToolCall).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tool_name: 'health_check' }),
      'Recursive delete'
    );
  });

  it('does NOT call toolRegistry.dispatch when blocked', async () => {
    await runSession(TRIGGER);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('returns is_error:true tool result back to Claude', async () => {
    await runSession(TRIGGER);
    // The second API call receives the blocked result as a tool_result message
    const secondCall = mockMessagesCreate.mock.calls[1][0];
    const toolResultMsg = secondCall.messages.find(
      m => m.role === 'user' && Array.isArray(m.content)
    );
    expect(toolResultMsg.content[0].is_error).toBe(true);
  });

  it('includes the block reason in the tool result content', async () => {
    await runSession(TRIGGER);
    const secondCall = mockMessagesCreate.mock.calls[1][0];
    const toolResultMsg = secondCall.messages.find(
      m => m.role === 'user' && Array.isArray(m.content)
    );
    expect(toolResultMsg.content[0].content).toContain('Recursive delete');
  });
});

// ---------------------------------------------------------------------------
// AC4 — Approval gate for medium / high / critical risk tools
// ---------------------------------------------------------------------------

describe('AC4 — approval gate for non-read tools', () => {
  beforeEach(() => {
    mockGetRiskLevel.mockReturnValue('medium');
    mockRequiresApproval.mockReturnValue('once');
  });

  it('calls approvalEngine.requiresApproval with the tool riskLevel', async () => {
    mockRequestApproval.mockResolvedValue({ approved: true, note: null });
    await runSession(TRIGGER);
    expect(mockRequiresApproval).toHaveBeenCalledWith(
      expect.objectContaining({ riskLevel: 'medium' })
    );
  });

  it('calls requestApproval when policy is "once"', async () => {
    mockRequestApproval.mockResolvedValue({ approved: true, note: null });
    await runSession(TRIGGER);
    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
  });

  it('executes the tool when operator approves', async () => {
    mockRequestApproval.mockResolvedValue({ approved: true, note: null });
    await runSession(TRIGGER);
    expect(mockDispatch).toHaveBeenCalledWith('health_check', {});
  });

  it('saves tool call as "denied" when operator denies', async () => {
    mockRequestApproval.mockResolvedValue({ approved: false, note: 'Not now' });
    await runSession(TRIGGER);
    expect(mockSaveToolCall).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tool_name: 'health_check' }),
      null,
      'denied'
    );
  });

  it('does NOT dispatch when operator denies', async () => {
    mockRequestApproval.mockResolvedValue({ approved: false, note: null });
    await runSession(TRIGGER);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('returns denial note in the tool result error content', async () => {
    mockRequestApproval.mockResolvedValue({ approved: false, note: 'Too risky' });
    await runSession(TRIGGER);
    const secondCall = mockMessagesCreate.mock.calls[1][0];
    const toolResultMsg = secondCall.messages.find(
      m => m.role === 'user' && Array.isArray(m.content)
    );
    expect(toolResultMsg.content[0].content).toContain('Too risky');
    expect(toolResultMsg.content[0].is_error).toBe(true);
  });

  it('does NOT call requestApproval for read-level tools', async () => {
    mockGetRiskLevel.mockReturnValue('read');
    mockRequiresApproval.mockReturnValue('auto');
    await runSession(TRIGGER);
    expect(mockRequestApproval).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC5 — Tool output sanitized before entering conversation history
// ---------------------------------------------------------------------------

describe('AC5 — output sanitized before conversation history', () => {
  it('calls sanitizeOutput on every tool result', async () => {
    await runSession(TRIGGER);
    expect(mockSanitizeOutput).toHaveBeenCalledTimes(1);
  });

  it('passes raw tool output to sanitizeOutput', async () => {
    await runSession(TRIGGER);
    expect(mockSanitizeOutput).toHaveBeenCalledWith(HEALTH_RESULT);
  });

  it('uses the sanitized value in the tool_result sent to Claude', async () => {
    mockSanitizeOutput.mockReturnValue('SANITIZED_OUTPUT');
    await runSession(TRIGGER);
    const secondCall = mockMessagesCreate.mock.calls[1][0];
    const toolResultMsg = secondCall.messages.find(
      m => m.role === 'user' && Array.isArray(m.content)
    );
    expect(toolResultMsg.content[0].content).toBe('SANITIZED_OUTPUT');
  });

  it('does NOT sanitize output of blocked tool calls', async () => {
    mockCheck.mockReturnValue({ blocked: true, reason: 'Blocked', pattern: 'x' });
    mockMessagesCreate
      .mockReset()
      .mockResolvedValueOnce(makeToolUseResponse())
      .mockResolvedValueOnce(makeEndTurnResponse());
    await runSession(TRIGGER);
    expect(mockSanitizeOutput).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC6 — Loop terminates on end_turn
// ---------------------------------------------------------------------------

describe('AC6 — terminates on stop_reason: end_turn', () => {
  it('returns the final text from the end_turn response', async () => {
    mockMessagesCreate.mockReset().mockResolvedValueOnce(
      makeEndTurnResponse('Task complete: all systems healthy.')
    );
    const result = await runSession(TRIGGER);
    expect(result.response).toBe('Task complete: all systems healthy.');
  });

  it('stops calling the API after end_turn', async () => {
    mockMessagesCreate.mockReset().mockResolvedValueOnce(makeEndTurnResponse());
    await runSession(TRIGGER);
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });

  it('does not call the API a second time when first response is end_turn', async () => {
    mockMessagesCreate.mockReset().mockResolvedValue(makeEndTurnResponse('Done.'));
    const result = await runSession(TRIGGER);
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    expect(result.response).toBe('Done.');
  });
});

// ---------------------------------------------------------------------------
// AC7 — Loop terminates after 20 iterations maximum
// ---------------------------------------------------------------------------

describe('AC7 — max-iterations guard', () => {
  beforeEach(() => {
    // Always respond with a tool_use to drive the loop to the cap
    mockMessagesCreate.mockReset().mockResolvedValue(makeToolUseResponse());
  });

  it('makes exactly 20 API calls before stopping', async () => {
    await runSession(TRIGGER);
    expect(mockMessagesCreate).toHaveBeenCalledTimes(20);
  });

  it('returns a graceful message when the cap is hit', async () => {
    const result = await runSession(TRIGGER);
    expect(result.response).toContain('Maximum iterations');
    expect(result.response).toContain('20');
  });

  it('still returns a valid session_id when the cap is hit', async () => {
    const result = await runSession(TRIGGER);
    expect(typeof result.session_id).toBe('string');
    expect(result.session_id.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC8 — All turns and tool calls logged to session.db
// ---------------------------------------------------------------------------

describe('AC8 — logging to session.db', () => {
  it('logs the assistant turn after each Claude response', async () => {
    await runSession(TRIGGER);
    const assistantCalls = mockSaveTurn.mock.calls.filter(c => c[1] === 'assistant');
    expect(assistantCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('includes token counts in the assistant turn', async () => {
    mockMessagesCreate.mockReset().mockResolvedValueOnce(makeEndTurnResponse());
    await runSession(TRIGGER);
    const assistantCall = mockSaveTurn.mock.calls.find(c => c[1] === 'assistant');
    expect(assistantCall[3]).toBe(100); // input tokens
    expect(assistantCall[4]).toBe(50);  // output tokens
  });

  it('saves tool results turn after tool execution', async () => {
    await runSession(TRIGGER);
    const toolCalls = mockSaveTurn.mock.calls.filter(c => c[1] === 'tool');
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('saves tool call to session.db after successful execution', async () => {
    await runSession(TRIGGER);
    expect(mockSaveToolCall).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tool_name: 'health_check', input: {} }),
      HEALTH_RESULT,
      'executed'
    );
  });

  it('stores tool risk_level in the tool call record', async () => {
    mockGetRiskLevel.mockReturnValue('read');
    await runSession(TRIGGER);
    expect(mockSaveToolCall).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ risk_level: 'read' }),
      expect.anything(),
      'executed'
    );
  });

  it('logs dispatch errors as executed with error payload', async () => {
    const toolErr = new Error('SSH timeout');
    toolErr.code  = 'SSH_TIMEOUT';
    mockDispatch.mockRejectedValueOnce(toolErr);
    mockMessagesCreate
      .mockReset()
      .mockResolvedValueOnce(makeToolUseResponse())
      .mockResolvedValueOnce(makeEndTurnResponse());

    await runSession(TRIGGER);

    expect(mockSaveToolCall).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tool_name: 'health_check' }),
      expect.objectContaining({ error: 'SSH timeout', code: 'SSH_TIMEOUT' }),
      'executed'
    );
  });
});

// ---------------------------------------------------------------------------
// AC9 — Session closed with summary on completion or error
// ---------------------------------------------------------------------------

describe('AC9 — session closure', () => {
  it('calls closeSession with the final text response on success', async () => {
    mockMessagesCreate.mockReset().mockResolvedValueOnce(
      makeEndTurnResponse('Health check passed.')
    );
    await runSession(TRIGGER);
    expect(mockCloseSession).toHaveBeenCalledWith(
      expect.any(String),
      'Health check passed.'
    );
  });

  it('calls closeSession with an error prefix when Claude API throws', async () => {
    mockMessagesCreate.mockReset().mockRejectedValueOnce(new Error('Rate limited'));
    await expect(runSession(TRIGGER)).rejects.toThrow('Rate limited');
    expect(mockCloseSession).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Error: Rate limited')
    );
  });

  it('re-throws the original error after closing the session', async () => {
    mockMessagesCreate.mockReset().mockRejectedValueOnce(new Error('API unavailable'));
    await expect(runSession(TRIGGER)).rejects.toThrow('API unavailable');
  });

  it('closes the session exactly once per runSession call', async () => {
    mockMessagesCreate.mockReset().mockResolvedValueOnce(makeEndTurnResponse());
    await runSession(TRIGGER);
    expect(mockCloseSession).toHaveBeenCalledTimes(1);
  });

  it('truncates very long summaries to 500 characters', async () => {
    const longText = 'x'.repeat(600);
    mockMessagesCreate.mockReset().mockResolvedValueOnce(
      makeEndTurnResponse(longText)
    );
    await runSession(TRIGGER);
    const [, summary] = mockCloseSession.mock.calls[0];
    expect(summary.length).toBeLessThanOrEqual(500);
  });
});

// ---------------------------------------------------------------------------
// AC10 — Uses claude-sonnet-4-6 model
// ---------------------------------------------------------------------------

describe('AC10 — model selection', () => {
  it('passes model "claude-sonnet-4-6" to every API call', async () => {
    await runSession(TRIGGER);
    for (const [callArgs] of mockMessagesCreate.mock.calls) {
      expect(callArgs.model).toBe('claude-sonnet-4-6');
    }
  });

  it('uses claude-sonnet-4-6 even for tool-loop iterations', async () => {
    // two iterations: tool_use then end_turn — both should use correct model
    expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
    for (const [callArgs] of mockMessagesCreate.mock.calls) {
      expect(callArgs.model).toBe('claude-sonnet-4-6');
    }
  });
});

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

describe('module exports', () => {
  it('exports runSession as a function', () => {
    expect(typeof runSession).toBe('function');
  });
});
