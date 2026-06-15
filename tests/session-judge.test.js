'use strict';

// ---------------------------------------------------------------------------
// Unit tests for the LLM-as-judge (Verification Loop spec, Layer B). The
// Anthropic client is mocked so no network calls are made; every failure path
// must degrade to a safe { verdict: 'uncertain', confidence: 0 } default.
// ---------------------------------------------------------------------------

const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () =>
  jest.fn(() => ({ messages: { create: (...a) => mockCreate(...a) } }))
);
jest.mock('../src/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const { judgeSession, VERDICT_TOOL } = require('../src/session-judge');

function verdictResponse(input) {
  return { content: [{ type: 'tool_use', name: 'record_verdict', input }] };
}

beforeEach(() => jest.clearAllMocks());

describe('judgeSession', () => {
  const base = { objective: 'restart the marketing engine', toolCalls: [], finalText: 'done', apiKey: 'k' };

  it('AC13: returns the verdict from the forced record_verdict tool call', async () => {
    mockCreate.mockResolvedValue(verdictResponse({ verdict: 'resolved', confidence: 0.9, reason: 'confirmed healthy' }));
    const v = await judgeSession(base);
    expect(v).toEqual({ verdict: 'resolved', confidence: 0.9, reason: 'confirmed healthy' });
  });

  it('forces the record_verdict tool and defaults to Haiku', async () => {
    mockCreate.mockResolvedValue(verdictResponse({ verdict: 'unresolved', confidence: 0.6, reason: 'still degraded' }));
    await judgeSession(base);
    const args = mockCreate.mock.calls[0][0];
    expect(args.tool_choice).toEqual({ type: 'tool', name: 'record_verdict' });
    expect(args.tools).toContainEqual(VERDICT_TOOL);
    expect(args.model).toMatch(/haiku/);
  });

  it('honours an explicit model override', async () => {
    mockCreate.mockResolvedValue(verdictResponse({ verdict: 'uncertain', confidence: 0.2, reason: 'x' }));
    await judgeSession({ ...base, model: 'claude-sonnet-4-6' });
    expect(mockCreate.mock.calls[0][0].model).toBe('claude-sonnet-4-6');
  });

  it('AC14: degrades to uncertain/0 on API error', async () => {
    mockCreate.mockRejectedValue(new Error('rate limited'));
    const v = await judgeSession(base);
    expect(v.verdict).toBe('uncertain');
    expect(v.confidence).toBe(0);
    expect(v.reason).toMatch(/judge error/);
  });

  it('AC14: degrades to uncertain/0 when there is no record_verdict block', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'I think it worked' }] });
    const v = await judgeSession(base);
    expect(v).toMatchObject({ verdict: 'uncertain', confidence: 0 });
  });

  it('degrades to uncertain when the verdict is not a known enum value', async () => {
    mockCreate.mockResolvedValue(verdictResponse({ verdict: 'maybe', confidence: 1, reason: 'x' }));
    const v = await judgeSession(base);
    expect(v.verdict).toBe('uncertain');
  });

  it('coerces a missing confidence to 0 without throwing', async () => {
    mockCreate.mockResolvedValue(verdictResponse({ verdict: 'resolved', reason: 'ok' }));
    const v = await judgeSession(base);
    expect(v).toMatchObject({ verdict: 'resolved', confidence: 0 });
  });
});
