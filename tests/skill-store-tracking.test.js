'use strict';

/**
 * Unit tests for skill success-rate tracking:
 *   - recordSkillUse(skillId, sessionId, success) increments success_count only on success
 *   - flagDegradedSkills returns skills below the success-rate floor
 *
 * better-sqlite3 is mocked with a pure-JS in-memory store so these tests run
 * on Windows without native bindings.
 */

// ---------------------------------------------------------------------------
// In-memory DB mock — mimics better-sqlite3 for the queries skill-store issues
// ---------------------------------------------------------------------------

let _mockStore;   // Map<id, skill-row>
let _mockUses;    // use-log rows
let _nextSkillId;
let _nextUseId;

function resetStore() {
  _mockStore    = new Map();
  _mockUses     = [];
  _nextSkillId  = 1;
  _nextUseId    = 1;
}

function mockMakeDb() {
  function prepare(sql) {
    const norm = sql.replace(/\s+/g, ' ').trim().toLowerCase();

    // ── UPDATE skills SET use_count + success_count ──────────────────────────
    if (norm.includes('success_count = success_count + 1')) {
      return {
        run(ts, id) {
          const row = _mockStore.get(Number(id));
          if (row) { row.use_count++; row.success_count++; row.last_used_at = ts; }
          return { changes: row ? 1 : 0 };
        },
      };
    }

    // ── UPDATE skills SET use_count only ────────────────────────────────────
    if (norm.includes('use_count = use_count + 1') && !norm.includes('success_count')) {
      return {
        run(ts, id) {
          const row = _mockStore.get(Number(id));
          if (row) { row.use_count++; row.last_used_at = ts; }
          return { changes: row ? 1 : 0 };
        },
      };
    }

    // ── INSERT INTO skill_uses ───────────────────────────────────────────────
    if (norm.startsWith('insert into skill_uses')) {
      return {
        run(skill_id, session_id, invoked_at) {
          const id = _nextUseId++;
          _mockUses.push({ id, skill_id, session_id, invoked_at });
          return { lastInsertRowid: id };
        },
      };
    }

    // ── INSERT INTO skills ───────────────────────────────────────────────────
    if (norm.startsWith('insert into skills')) {
      return {
        run(name, title, description, domain, content, version, created_at, updated_at) {
          const id = _nextSkillId++;
          _mockStore.set(id, {
            id, name, title, description, domain, content, version,
            use_count: 0, success_count: 0, last_used_at: null,
            created_at, updated_at,
          });
          return { lastInsertRowid: id };
        },
      };
    }

    // ── SELECT skills WHERE name = ? ────────────────────────────────────────
    if (norm.includes('from skills') && norm.includes('where name =')) {
      return { get(name) { return [..._mockStore.values()].find(r => r.name === name); } };
    }

    // ── SELECT skills WHERE id = ? ──────────────────────────────────────────
    if (norm.includes('from skills') && norm.includes('where id =')) {
      return { get(id) { return _mockStore.get(Number(id)); } };
    }

    // ── flagDegradedSkills ───────────────────────────────────────────────────
    if (norm.includes('cast(success_count as real) / use_count')) {
      return {
        all(minUseCount, minSuccessRate) {
          return [..._mockStore.values()]
            .filter(r => r.use_count >= minUseCount &&
                         (r.success_count / r.use_count) < minSuccessRate)
            .map(r => ({
              id:            r.id,
              name:          r.name,
              title:         r.title,
              domain:        r.domain,
              use_count:     r.use_count,
              success_count: r.success_count,
              success_rate:  r.success_count / r.use_count,
            }))
            .sort((a, b) => a.success_rate - b.success_rate || b.use_count - a.use_count);
        },
      };
    }

    // ── Fallback ─────────────────────────────────────────────────────────────
    return {
      run:  jest.fn().mockReturnValue({ lastInsertRowid: 0, changes: 0 }),
      get:  jest.fn().mockReturnValue(undefined),
      all:  jest.fn().mockReturnValue([]),
    };
  }

  return {
    pragma:      jest.fn(),
    exec:        jest.fn(),
    transaction: fn => () => fn(),
    close:       jest.fn(),
    prepare,
    _store:      _mockStore,
    _uses:       _mockUses,
  };
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('better-sqlite3', () => function MockDatabase() { return mockMakeDb(); });

jest.mock('../config/cosa.config', () => ({
  getConfig: () => ({ env: { dataDir: '/tmp/cosa-test-skill-tracking' } }),
}));

jest.mock('../src/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

jest.mock('js-yaml', () => ({
  load: jest.fn().mockReturnValue({}),
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

const fs = require('fs');
jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {});

const skillStore = require('../src/skill-store');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedSkill(overrides = {}) {
  const id = _nextSkillId;
  _mockStore.set(id, {
    id,
    name:          `test-skill-${id}`,
    title:         'Test Skill',
    description:   'A test skill',
    domain:        'monitoring',
    content:       '## Steps\n1. Do thing\n',
    version:       1,
    use_count:     overrides.use_count     ?? 0,
    success_count: overrides.success_count ?? 0,
    last_used_at:  null,
    created_at:    new Date().toISOString(),
    updated_at:    new Date().toISOString(),
    ...overrides,
  });
  _nextSkillId++;
  return id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetStore();
});

// ── recordSkillUse ──────────────────────────────────────────────────────────

describe('recordSkillUse', () => {
  test('increments use_count and success_count when success=true', () => {
    const id = seedSkill({ use_count: 3, success_count: 2 });
    skillStore.recordSkillUse(id, 'sess-001', true);
    const row = _mockStore.get(id);
    expect(row.use_count).toBe(4);
    expect(row.success_count).toBe(3);
  });

  test('increments use_count only when success=false', () => {
    const id = seedSkill({ use_count: 3, success_count: 2 });
    skillStore.recordSkillUse(id, 'sess-002', false);
    const row = _mockStore.get(id);
    expect(row.use_count).toBe(4);
    expect(row.success_count).toBe(2);  // unchanged
  });

  test('defaults success to false when omitted', () => {
    const id = seedSkill({ use_count: 1, success_count: 1 });
    skillStore.recordSkillUse(id, 'sess-003');
    const row = _mockStore.get(id);
    expect(row.success_count).toBe(1);  // unchanged
  });

  test('inserts a skill_uses row on every call', () => {
    const id = seedSkill();
    skillStore.recordSkillUse(id, 'sess-004', true);
    skillStore.recordSkillUse(id, 'sess-005', false);
    expect(_mockUses).toHaveLength(2);
    expect(_mockUses[0]).toMatchObject({ skill_id: id, session_id: 'sess-004' });
    expect(_mockUses[1]).toMatchObject({ skill_id: id, session_id: 'sess-005' });
  });

  test('stores null sessionId when sessionId is null', () => {
    const id = seedSkill();
    skillStore.recordSkillUse(id, null, true);
    expect(_mockUses[0].session_id).toBeNull();
  });

  test('returns the skill_uses row id', () => {
    const id = seedSkill();
    const useId = skillStore.recordSkillUse(id, 'sess-006', true);
    expect(typeof useId).toBe('number');
    expect(useId).toBeGreaterThan(0);
  });
});

// ── flagDegradedSkills ──────────────────────────────────────────────────────

describe('flagDegradedSkills', () => {
  test('returns skill with use_count >= 5 and success rate below 0.6', () => {
    seedSkill({ name: 'bad-skill', use_count: 10, success_count: 4 });  // 40% rate
    const flagged = skillStore.flagDegradedSkills();
    expect(flagged).toHaveLength(1);
    expect(flagged[0].name).toBe('bad-skill');
    expect(flagged[0].success_rate).toBeCloseTo(0.4);
  });

  test('does NOT flag skill with fewer than minUseCount invocations', () => {
    seedSkill({ name: 'new-skill', use_count: 4, success_count: 0 });  // only 4 uses
    expect(skillStore.flagDegradedSkills()).toHaveLength(0);
  });

  test('does NOT flag skill with success rate >= 0.6', () => {
    seedSkill({ name: 'good-skill', use_count: 10, success_count: 6 });  // exactly 60%
    expect(skillStore.flagDegradedSkills()).toHaveLength(0);
  });

  test('does NOT flag skill with success rate above threshold', () => {
    seedSkill({ name: 'great-skill', use_count: 20, success_count: 18 });  // 90%
    expect(skillStore.flagDegradedSkills()).toHaveLength(0);
  });

  test('orders results by success rate ascending (worst first)', () => {
    seedSkill({ name: 'skill-a', use_count: 10, success_count: 4 });  // 40%
    seedSkill({ name: 'skill-b', use_count: 10, success_count: 1 });  // 10%
    seedSkill({ name: 'skill-c', use_count: 10, success_count: 3 });  // 30%
    const flagged = skillStore.flagDegradedSkills();
    expect(flagged.map(r => r.name)).toEqual(['skill-b', 'skill-c', 'skill-a']);
  });

  test('respects custom minUseCount parameter', () => {
    seedSkill({ name: 'low-use', use_count: 3, success_count: 0 });
    // With default minUseCount=5: not flagged
    expect(skillStore.flagDegradedSkills(5, 0.6)).toHaveLength(0);
    // With minUseCount=3: flagged
    expect(skillStore.flagDegradedSkills(3, 0.6)).toHaveLength(1);
  });

  test('respects custom minSuccessRate parameter', () => {
    seedSkill({ name: 'borderline', use_count: 10, success_count: 7 });  // 70%
    // Default threshold 0.6: not flagged (70 > 60)
    expect(skillStore.flagDegradedSkills(5, 0.6)).toHaveLength(0);
    // Raise threshold to 0.8: now flagged (70 < 80)
    expect(skillStore.flagDegradedSkills(5, 0.8)).toHaveLength(1);
  });

  test('returns empty array when no skills are degraded', () => {
    seedSkill({ name: 'fine', use_count: 20, success_count: 18 });
    expect(skillStore.flagDegradedSkills()).toHaveLength(0);
  });

  test('returns empty array when store is empty', () => {
    expect(skillStore.flagDegradedSkills()).toHaveLength(0);
  });
});
