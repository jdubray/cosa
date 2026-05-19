'use strict';

const mockSearchTurns = jest.fn();
jest.mock('../../src/session-store', () => ({
  searchTurns: (...a) => mockSearchTurns(...a),
}));

const { handler, name, riskLevel, schema } = require('../../src/tools/archive-search');

beforeEach(() => {
  mockSearchTurns.mockReset();
});

// Build a fake turn row.
function row(overrides = {}) {
  return {
    session_id: 'sess-abc',
    turn_index: 0,
    role:       'assistant',
    created_at: '2026-05-15T10:00:00.000Z',
    content:    'baseline content',
    ...overrides,
  };
}

describe('archive_search — metadata', () => {
  it('exports name and risk level', () => {
    expect(name).toBe('archive_search');
    expect(riskLevel).toBe('read');
  });

  it('declares query as required', () => {
    expect(schema.inputSchema.required).toEqual(['query']);
  });

  it('caps limit at 50', () => {
    expect(schema.inputSchema.properties.limit.maximum).toBe(50);
  });
});

describe('archive_search — handler', () => {
  it('passes the query and default limit (10) to searchTurns when limit omitted', () => {
    mockSearchTurns.mockReturnValue([]);
    handler({ query: 'backup' });
    expect(mockSearchTurns).toHaveBeenCalledWith('backup', 10);
  });

  it('honors a caller-supplied limit', () => {
    mockSearchTurns.mockReturnValue([]);
    handler({ query: 'backup', limit: 25 });
    expect(mockSearchTurns).toHaveBeenCalledWith('backup', 25);
  });

  it('clamps limit > MAX_LIMIT (50) down to 50', () => {
    mockSearchTurns.mockReturnValue([]);
    handler({ query: 'backup', limit: 9999 });
    expect(mockSearchTurns).toHaveBeenCalledWith('backup', 50);
  });

  it('returns an empty results array and total_found=0 when no matches', () => {
    mockSearchTurns.mockReturnValue([]);
    const r = handler({ query: 'no-match' });
    expect(r.results).toEqual([]);
    expect(r.total_found).toBe(0);
  });

  it('maps each row into the public result shape', () => {
    mockSearchTurns.mockReturnValue([
      row({ turn_index: 3, role: 'user', content: 'restart needed' }),
    ]);
    const r = handler({ query: 'restart' });
    expect(r.total_found).toBe(1);
    expect(r.results[0]).toEqual({
      session_id: 'sess-abc',
      turn_index: 3,
      role:       'user',
      created_at: '2026-05-15T10:00:00.000Z',
      excerpt:    'restart needed',
    });
  });

  it('truncates long content to ~200 chars with an ellipsis', () => {
    const long = 'x'.repeat(500);
    mockSearchTurns.mockReturnValue([row({ content: long })]);
    const r = handler({ query: 'x' });
    expect(r.results[0].excerpt.length).toBe(200);
    expect(r.results[0].excerpt.endsWith('…')).toBe(true);
  });

  it('leaves short content (<200 chars) untouched, no ellipsis', () => {
    mockSearchTurns.mockReturnValue([row({ content: 'short text' })]);
    const r = handler({ query: 'short' });
    expect(r.results[0].excerpt).toBe('short text');
  });

  it('returns excerpt="" when row.content is null', () => {
    mockSearchTurns.mockReturnValue([row({ content: null })]);
    const r = handler({ query: 'anything' });
    expect(r.results[0].excerpt).toBe('');
  });

  it('preserves the order returned by searchTurns', () => {
    mockSearchTurns.mockReturnValue([
      row({ turn_index: 1, content: 'first' }),
      row({ turn_index: 2, content: 'second' }),
      row({ turn_index: 3, content: 'third' }),
    ]);
    const r = handler({ query: 'x' });
    expect(r.results.map((x) => x.turn_index)).toEqual([1, 2, 3]);
  });
});
