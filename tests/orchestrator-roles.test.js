'use strict';

// ---------------------------------------------------------------------------
// Unit tests for the orchestrator's role-routing tables and deriveRole().
// These are pure functions/maps — no Claude API or DB involved.
// ---------------------------------------------------------------------------

const {
  deriveRole,
  MODEL_BY_ROLE,
  MAX_TOKENS_BY_ROLE,
  MAX_ITER_BY_ROLE,
} = require('../src/orchestrator');

const HAIKU  = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-6';

describe('deriveRole()', () => {
  it('honours an explicit options.role over the trigger type', () => {
    expect(deriveRole({ type: 'cron' }, { role: 'audit' })).toBe('audit');
    expect(deriveRole({ type: 'email' }, { role: 'query' })).toBe('query');
  });

  it('derives probe for a cron trigger when no role is given', () => {
    expect(deriveRole({ type: 'cron' }, {})).toBe('probe');
  });

  it('derives action for email/cli triggers when no role is given (safe default)', () => {
    expect(deriveRole({ type: 'email' }, {})).toBe('action');
    expect(deriveRole({ type: 'cli' }, {})).toBe('action');
  });
});

describe('role routing tables', () => {
  it('selects the cheap Haiku model for probe and audit', () => {
    expect(MODEL_BY_ROLE.probe).toBe(HAIKU);
    expect(MODEL_BY_ROLE.audit).toBe(HAIKU);
  });

  it('selects Sonnet for query and action', () => {
    expect(MODEL_BY_ROLE.query).toBe(SONNET);
    expect(MODEL_BY_ROLE.action).toBe(SONNET);
  });

  it('assigns token budgets per role', () => {
    expect(MAX_TOKENS_BY_ROLE.probe).toBe(2048);
    expect(MAX_TOKENS_BY_ROLE.audit).toBe(4096);
    expect(MAX_TOKENS_BY_ROLE.query).toBe(8192);
    expect(MAX_TOKENS_BY_ROLE.action).toBe(8192);
  });

  it('caps audit iterations lower than the others', () => {
    expect(MAX_ITER_BY_ROLE.audit).toBe(10);
    expect(MAX_ITER_BY_ROLE.probe).toBe(20);
    expect(MAX_ITER_BY_ROLE.query).toBe(20);
    expect(MAX_ITER_BY_ROLE.action).toBe(20);
  });

  it('defines all four roles in every routing table', () => {
    const roles = ['probe', 'query', 'action', 'audit'];
    [MODEL_BY_ROLE, MAX_TOKENS_BY_ROLE, MAX_ITER_BY_ROLE].forEach(table => {
      expect(Object.keys(table).sort()).toEqual([...roles].sort());
    });
  });

  it('no routing table has an entry for an unknown role (forces normalisation)', () => {
    // runSession normalises an unknown role to action; the tables themselves
    // must not silently define a stray role.
    expect(MODEL_BY_ROLE.bogus).toBeUndefined();
    expect(MAX_TOKENS_BY_ROLE.bogus).toBeUndefined();
    expect(MAX_ITER_BY_ROLE.bogus).toBeUndefined();
  });
});
