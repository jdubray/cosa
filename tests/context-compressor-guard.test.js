'use strict';

/**
 * Isolated tests for context-compressor guards that do not require a real
 * SQLite database.  The full integration suite lives in
 * tests/phase2/t-2.6-context-compression.test.js but cannot run on Win32
 * because better-sqlite3 is compiled for Linux.  These unit tests cover
 * the H5 early-return guard and can run anywhere.
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockMessagesCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () =>
  jest.fn(() => ({ messages: { create: (...a) => mockMessagesCreate(...a) } }))
);

jest.mock('../config/cosa.config', () => ({
  getConfig: () => ({
    env: { anthropic: { apiKey: 'test-key' } },
    appliance: {
      context_compression: {
        enabled:                   true,
        max_turns_before_compress: 12,
        protect_first_n:           3,
        protect_last_n:            4,
        compression_model:         'claude-haiku-4-5-20251001',
      },
    },
  }),
}));

// Avoid pulling in better-sqlite3 (Linux binary, not loadable on Win32).
jest.mock('../src/session-store', () => ({
  saveTurn:               jest.fn(),
  markSessionCompressed:  jest.fn(),
}));

jest.mock('../src/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

const { compress, needsCompression } = require('../src/context-compressor');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  jest.clearAllMocks();
});

describe('context-compressor — H5 guard', () => {
  it('compress() returns messages unchanged when middle.length === 0', async () => {
    // With protectFirstN=3 and protectLastN=4, a 3-message array has no middle
    // turns.  compress() must return the original array without calling Haiku.
    const msgs = [
      { role: 'user',      content: 'trigger' },
      { role: 'assistant', content: 'response 1' },
      { role: 'user',      content: 'follow-up' },
    ];

    const result = await compress(msgs, 'h5-guard-session');

    expect(result).toEqual(msgs);
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it('compress() returns messages unchanged when array is exactly protectFirstN + protectLastN', async () => {
    // 3 + 4 = 7 messages → middle is empty → no compression
    const msgs = Array.from({ length: 7 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}`,
    }));

    const result = await compress(msgs, 'h5-guard-session-2');

    expect(result).toEqual(msgs);
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it('needsCompression returns false when messages.length <= threshold', () => {
    const msgs = Array.from({ length: 12 }, (_, i) => ({ role: 'user', content: `msg ${i}` }));
    expect(needsCompression(msgs)).toBe(false);
  });

  it('needsCompression returns true when messages.length exceeds threshold', () => {
    const msgs = Array.from({ length: 13 }, (_, i) => ({ role: 'user', content: `msg ${i}` }));
    expect(needsCompression(msgs)).toBe(true);
  });
});
