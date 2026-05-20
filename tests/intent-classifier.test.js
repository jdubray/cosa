'use strict';

// ---------------------------------------------------------------------------
// Mocks — Anthropic SDK and config. mock-prefixed names are hoist-safe.
// ---------------------------------------------------------------------------

const mockCreate    = jest.fn();
const mockGetConfig = jest.fn();

jest.mock('@anthropic-ai/sdk', () =>
  jest.fn().mockImplementation(() => ({
    messages: { create: (...args) => mockCreate(...args) },
  }))
);

jest.mock('../config/cosa.config', () => ({
  getConfig: (...args) => mockGetConfig(...args),
}));

const { classify } = require('../src/intent-classifier');

/** Build a fake Anthropic response with the given text content. */
function reply(text) {
  return { content: [{ type: 'text', text }] };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetConfig.mockReturnValue({ env: { anthropicApiKey: 'sk-ant-test' } });
});

// ---------------------------------------------------------------------------
// Regex fast path — no API call
// ---------------------------------------------------------------------------

describe('regex fast path', () => {
  it('classifies a clear query without calling the model', async () => {
    const result = await classify('How many active orders are there right now?');
    expect(result.intent).toBe('query');
    expect(result.confidence).toBe(0.9);
    expect(result.raw).toBe('regex');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('classifies a clear command without calling the model', async () => {
    const result = await classify('Please restart the POS service.');
    expect(result.intent).toBe('command');
    expect(result.confidence).toBe(0.9);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('falls through to the model when both keyword sets match', async () => {
    mockCreate.mockResolvedValue(reply('{"intent":"command","confidence":0.8}'));
    // "show" (query) + "restart" (command) both present.
    const result = await classify('Can you show me the status and then restart it?');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(result.intent).toBe('command');
  });

  it('falls through to the model when neither keyword set matches', async () => {
    mockCreate.mockResolvedValue(reply('{"intent":"ambiguous","confidence":0.3}'));
    const result = await classify('The thing from yesterday.');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(result.intent).toBe('ambiguous');
  });
});

// ---------------------------------------------------------------------------
// Haiku fallback — parsing and resilience
// ---------------------------------------------------------------------------

describe('Haiku fallback', () => {
  // Use a both-match phrase so we always reach the model.
  const AMBIG = 'show and restart';

  it('parses a clean JSON object', async () => {
    mockCreate.mockResolvedValue(reply('{"intent":"query","confidence":0.77}'));
    const result = await classify(AMBIG);
    expect(result).toMatchObject({ intent: 'query', confidence: 0.77 });
  });

  it('extracts JSON embedded in surrounding prose / fences', async () => {
    mockCreate.mockResolvedValue(reply('Sure!\n```json\n{"intent":"command","confidence":0.6}\n```'));
    const result = await classify(AMBIG);
    expect(result.intent).toBe('command');
    expect(result.confidence).toBe(0.6);
  });

  it('clamps out-of-range confidence into [0,1]', async () => {
    mockCreate.mockResolvedValue(reply('{"intent":"query","confidence":7}'));
    const result = await classify(AMBIG);
    expect(result.confidence).toBe(1);
  });

  it('defaults confidence to 0.5 when missing or non-numeric', async () => {
    mockCreate.mockResolvedValue(reply('{"intent":"query"}'));
    const result = await classify(AMBIG);
    expect(result.confidence).toBe(0.5);
  });

  it('returns ambiguous on malformed JSON', async () => {
    mockCreate.mockResolvedValue(reply('not json at all'));
    const result = await classify(AMBIG);
    expect(result.intent).toBe('ambiguous');
    expect(result.confidence).toBe(0.0);
    expect(result.raw).toMatch(/^error:/);
  });

  it('returns ambiguous on an unexpected intent value', async () => {
    mockCreate.mockResolvedValue(reply('{"intent":"delete-everything","confidence":1}'));
    const result = await classify(AMBIG);
    expect(result.intent).toBe('ambiguous');
  });

  it('returns ambiguous when the API call throws', async () => {
    mockCreate.mockRejectedValue(new Error('network down'));
    const result = await classify(AMBIG);
    expect(result.intent).toBe('ambiguous');
    expect(result.raw).toContain('network down');
  });
});
