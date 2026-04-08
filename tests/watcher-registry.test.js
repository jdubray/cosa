'use strict';

/**
 * Unit tests for watcher-registry.js.
 *
 * better-sqlite3 native bindings do not work in the Windows Jest environment,
 * so we provide a pure-JavaScript in-memory mock for the database that
 * implements exactly the subset of the SQLite prepared-statement API that
 * watcher-registry uses.
 */

// ---------------------------------------------------------------------------
// Pure-JS in-memory DB mock
// Named with "mock" prefix so jest.mock() factory can reference it.
// ---------------------------------------------------------------------------

let mockDb = null;

/**
 * Build a minimal in-memory database that mimics the better-sqlite3 API for
 * the `watchers` table.  A plain Map is used as backing storage.
 *
 * The `prepare(sql)` method detects the statement type by keyword inspection
 * and returns a statement object whose `.run()` / `.all()` / `.get()` methods
 * manipulate the in-memory store.
 *
 * Tests can inspect store contents directly via `mockDb._store`.
 */
function makeInMemoryDb() {
  /** @type {Map<string, object>} */
  const store = new Map();

  function stmt(sql) {
    const s = sql.trim().toLowerCase().replace(/\s+/g, ' ');

    // ── UPSERT ───────────────────────────────────────────────────────────────
    if (s.includes('on conflict')) {
      return {
        run({ id, name, description, code, created_at }) {
          if (store.has(id)) {
            const r = store.get(id);
            r.name = name; r.description = description;
            r.code = code; r.enabled = 1;
          } else {
            store.set(id, {
              id, name, description, code, created_at,
              last_triggered_at: null, trigger_count: 0,
              last_alerted_at: null, enabled: 1,
            });
          }
        },
        all() { return []; },
        get()  { return undefined; },
      };
    }

    // ── SELECT enabled watchers ───────────────────────────────────────────
    if (s.includes('where enabled = 1')) {
      return {
        run() {},
        all() {
          return [...store.values()]
            .filter(r => r.enabled === 1)
            .sort((a, b) => a.created_at.localeCompare(b.created_at));
        },
        get() { return undefined; },
      };
    }

    // ── SELECT all watchers ───────────────────────────────────────────────
    if (s.startsWith('select') && s.includes('order by')) {
      return {
        run() {},
        all() {
          return [...store.values()]
            .sort((a, b) => a.created_at.localeCompare(b.created_at));
        },
        get() { return undefined; },
      };
    }

    // ── UPDATE enabled ────────────────────────────────────────────────────
    if (s.includes('set enabled')) {
      return {
        run({ id, enabled }) {
          const r = store.get(id);
          if (r) { r.enabled = enabled; return { changes: 1 }; }
          return { changes: 0 };
        },
        all() { return []; },
        get()  { return undefined; },
      };
    }

    // ── DELETE ────────────────────────────────────────────────────────────
    if (s.startsWith('delete')) {
      return {
        run({ id }) {
          const existed = store.has(id);
          store.delete(id);
          return { changes: existed ? 1 : 0 };
        },
        all() { return []; },
        get()  { return undefined; },
      };
    }

    // ── UPDATE last_triggered_at / trigger_count ──────────────────────────
    if (s.includes('trigger_count')) {
      return {
        run({ id, ts }) {
          const r = store.get(id);
          if (r) { r.last_triggered_at = ts; r.trigger_count += 1; }
        },
        all() { return []; },
        get()  { return undefined; },
      };
    }

    // ── UPDATE last_alerted_at ────────────────────────────────────────────
    if (s.includes('last_alerted_at')) {
      return {
        run({ id, ts }) {
          const r = store.get(id);
          if (r) r.last_alerted_at = ts;
        },
        all() { return []; },
        get()  { return undefined; },
      };
    }

    // Fallback — ignore unknown statements
    return { run() {}, all() { return []; }, get() { return undefined; } };
  }

  return { prepare: stmt, _store: store };
}

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('../src/session-store', () => ({ getDb: () => mockDb }));
jest.mock('../config/cosa.config');
jest.mock('../src/logger', () => ({
  createLogger: () => ({
    info:  jest.fn(),
    warn:  jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  }),
}));

const { getConfig }   = require('../config/cosa.config');
const watcherRegistry = require('../src/watcher-registry');

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function setConfig({ timeoutMs = 200, cooldownMinutes = 30 } = {}) {
  getConfig.mockReturnValue({
    appliance: {
      tools: {
        appliance_status_poll: {
          watcher_timeout_ms:     timeoutMs,
          alert_cooldown_minutes: cooldownMinutes,
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Watcher code snippets
// ---------------------------------------------------------------------------

const ALWAYS_TRIGGER = `function w(s) { return { triggered: true, message: 'always' }; }`;
const NEVER_TRIGGER  = `function w(s) { return { triggered: false }; }`;
const PRINTER_CODE   = `function watch(status) {
  var p = status && status.hardware && status.hardware.printer;
  if (!p || p.status === 'fault') return { triggered: true, message: 'Printer fault' };
  return { triggered: false };
}`;
const BAD_RETURN     = `function w(s) { return "not an object"; }`;
const NULL_RETURN    = `function w(s) { return null; }`;
const THROWS_CODE    = `function w(s) { throw new Error('boom'); }`;
const TIMEOUT_CODE   = `function w(s) { while(true) {} }`;
const NO_REQUIRE     = `function w(s) { return { triggered: (typeof require !== 'undefined') }; }`;
const NO_PROCESS     = `function w(s) { return { triggered: (typeof process !== 'undefined') }; }`;
const MUTATE_CODE    = `function w(s) { s.injected = 'evil'; return { triggered: false }; }`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Push a watcher's last_alerted_at back in time to clear the cooldown. */
function backdateAlerted(id, minutesAgo = 31) {
  const row = mockDb._store.get(id);
  if (row) row.last_alerted_at = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockDb = makeInMemoryDb();
  watcherRegistry._resetCache();   // force re-prepare against new mockDb
  jest.clearAllMocks();
  setConfig();
});

// ===========================================================================
// register
// ===========================================================================

describe('register', () => {
  test('stores a new watcher in the store', async () => {
    await watcherRegistry.register({ id: 'w1', name: 'W1', description: 'desc', code: NEVER_TRIGGER });

    const row = mockDb._store.get('w1');
    expect(row).toBeDefined();
    expect(row.name).toBe('W1');
    expect(row.enabled).toBe(1);
  });

  test('upserts — replaces existing watcher with same id', async () => {
    await watcherRegistry.register({ id: 'w1', name: 'Old', description: 'old', code: NEVER_TRIGGER });
    await watcherRegistry.register({ id: 'w1', name: 'New', description: 'new', code: ALWAYS_TRIGGER });

    const row = mockDb._store.get('w1');
    expect(row.name).toBe('New');
    expect(row.code).toBe(ALWAYS_TRIGGER);
  });

  test('re-enables disabled watcher on upsert', async () => {
    await watcherRegistry.register({ id: 'w1', name: 'W', description: 'd', code: NEVER_TRIGGER });
    await watcherRegistry.setEnabled('w1', false);
    await watcherRegistry.register({ id: 'w1', name: 'W', description: 'd', code: NEVER_TRIGGER });

    expect(mockDb._store.get('w1').enabled).toBe(1);
  });

  // ── Input validation ──────────────────────────────────────────────────────

  test('rejects id with uppercase letters', async () => {
    await expect(
      watcherRegistry.register({ id: 'BadId', name: 'N', description: 'd', code: NEVER_TRIGGER })
    ).rejects.toMatchObject({ code: 'WATCHER_INVALID' });
  });

  test('rejects id with spaces', async () => {
    await expect(
      watcherRegistry.register({ id: 'bad id', name: 'N', description: 'd', code: NEVER_TRIGGER })
    ).rejects.toMatchObject({ code: 'WATCHER_INVALID' });
  });

  test('rejects empty id', async () => {
    await expect(
      watcherRegistry.register({ id: '', name: 'N', description: 'd', code: NEVER_TRIGGER })
    ).rejects.toMatchObject({ code: 'WATCHER_INVALID' });
  });

  test('rejects code exceeding 8192 bytes', async () => {
    const bigCode = `function w(s) { return { triggered: false }; } /* ${'x'.repeat(8200)} */`;
    await expect(
      watcherRegistry.register({ id: 'w1', name: 'N', description: 'd', code: bigCode })
    ).rejects.toMatchObject({ code: 'WATCHER_INVALID' });
  });

  test('rejects empty code', async () => {
    await expect(
      watcherRegistry.register({ id: 'w1', name: 'N', description: 'd', code: '' })
    ).rejects.toMatchObject({ code: 'WATCHER_INVALID' });
  });

  test('rejects empty name', async () => {
    await expect(
      watcherRegistry.register({ id: 'w1', name: '', description: 'd', code: NEVER_TRIGGER })
    ).rejects.toMatchObject({ code: 'WATCHER_INVALID' });
  });

  test('rejects empty description', async () => {
    await expect(
      watcherRegistry.register({ id: 'w1', name: 'N', description: '', code: NEVER_TRIGGER })
    ).rejects.toMatchObject({ code: 'WATCHER_INVALID' });
  });

  test('accepts valid underscore-separated id', async () => {
    await expect(
      watcherRegistry.register({ id: 'high_pending_orders', name: 'N', description: 'd', code: NEVER_TRIGGER })
    ).resolves.toBeUndefined();
  });
});

// ===========================================================================
// list
// ===========================================================================

describe('list', () => {
  test('returns all watchers including disabled', async () => {
    await watcherRegistry.register({ id: 'a', name: 'A', description: 'aa', code: NEVER_TRIGGER });
    await watcherRegistry.register({ id: 'b', name: 'B', description: 'bb', code: NEVER_TRIGGER });
    await watcherRegistry.setEnabled('b', false);

    const all = await watcherRegistry.list();
    expect(all).toHaveLength(2);
    expect(all.map(w => w.id).sort()).toEqual(['a', 'b']);
  });
});

// ===========================================================================
// setEnabled / remove
// ===========================================================================

describe('setEnabled', () => {
  test('disables a watcher', async () => {
    await watcherRegistry.register({ id: 'w', name: 'W', description: 'd', code: ALWAYS_TRIGGER });
    await watcherRegistry.setEnabled('w', false);
    expect(mockDb._store.get('w').enabled).toBe(0);
  });

  test('re-enables a watcher', async () => {
    await watcherRegistry.register({ id: 'w', name: 'W', description: 'd', code: ALWAYS_TRIGGER });
    await watcherRegistry.setEnabled('w', false);
    await watcherRegistry.setEnabled('w', true);
    expect(mockDb._store.get('w').enabled).toBe(1);
  });

  test('throws WATCHER_NOT_FOUND for unknown id', async () => {
    await expect(
      watcherRegistry.setEnabled('ghost', true)
    ).rejects.toMatchObject({ code: 'WATCHER_NOT_FOUND' });
  });
});

describe('remove', () => {
  test('deletes the watcher', async () => {
    await watcherRegistry.register({ id: 'w', name: 'W', description: 'd', code: NEVER_TRIGGER });
    await watcherRegistry.remove('w');
    expect(mockDb._store.has('w')).toBe(false);
  });

  test('throws WATCHER_NOT_FOUND for unknown id', async () => {
    await expect(
      watcherRegistry.remove('ghost')
    ).rejects.toMatchObject({ code: 'WATCHER_NOT_FOUND' });
  });
});

// ===========================================================================
// runAll — basic
// ===========================================================================

describe('runAll — basic', () => {
  test('returns empty alerts when no watchers registered', async () => {
    const result = await watcherRegistry.runAll({});
    expect(result.alerts).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.watchers_evaluated).toBe(0);
  });

  test('no alert when watcher does not trigger', async () => {
    await watcherRegistry.register({ id: 'noop', name: 'Noop', description: 'd', code: NEVER_TRIGGER });
    const result = await watcherRegistry.runAll({ hardware: { printer: { status: 'ok' } } });
    expect(result.alerts).toHaveLength(0);
  });

  test('alert when watcher triggers', async () => {
    await watcherRegistry.register({ id: 'always', name: 'Always', description: 'd', code: ALWAYS_TRIGGER });
    const result = await watcherRegistry.runAll({});

    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]).toMatchObject({
      watcher_id:   'always',
      watcher_name: 'Always',
      message:      'always',
    });
    expect(result.alerts[0].triggered_at).toBeTruthy();
  });

  test('printer watcher triggers on fault', async () => {
    await watcherRegistry.register({ id: 'p', name: 'Printer', description: 'd', code: PRINTER_CODE });
    const result = await watcherRegistry.runAll({ hardware: { printer: { status: 'fault' } } });
    expect(result.alerts[0].message).toBe('Printer fault');
  });

  test('printer watcher silent when ok', async () => {
    await watcherRegistry.register({ id: 'p', name: 'Printer', description: 'd', code: PRINTER_CODE });
    const result = await watcherRegistry.runAll({ hardware: { printer: { status: 'ok' } } });
    expect(result.alerts).toHaveLength(0);
  });
});

// ===========================================================================
// runAll — DB state updates
// ===========================================================================

describe('runAll — DB state updates', () => {
  test('increments trigger_count on each trigger', async () => {
    await watcherRegistry.register({ id: 'w', name: 'W', description: 'd', code: ALWAYS_TRIGGER });

    await watcherRegistry.runAll({});   // fire 1 → sets last_alerted_at
    backdateAlerted('w');               // push past 30-min cooldown
    await watcherRegistry.runAll({});   // fire 2

    expect(mockDb._store.get('w').trigger_count).toBe(2);
  });

  test('sets last_alerted_at on first trigger', async () => {
    await watcherRegistry.register({ id: 'w', name: 'W', description: 'd', code: ALWAYS_TRIGGER });
    await watcherRegistry.runAll({});
    expect(mockDb._store.get('w').last_alerted_at).toBeTruthy();
  });
});

// ===========================================================================
// runAll — cooldown
// ===========================================================================

describe('runAll — cooldown', () => {
  test('suppresses alert within cooldown window', async () => {
    await watcherRegistry.register({ id: 'w', name: 'W', description: 'd', code: ALWAYS_TRIGGER });

    const first = await watcherRegistry.runAll({});
    expect(first.alerts).toHaveLength(1);

    const second = await watcherRegistry.runAll({});  // still within 30-min cooldown
    expect(second.alerts).toHaveLength(0);
  });

  test('fires again after cooldown passes', async () => {
    await watcherRegistry.register({ id: 'w', name: 'W', description: 'd', code: ALWAYS_TRIGGER });
    await watcherRegistry.runAll({});
    backdateAlerted('w');  // 31 minutes ago

    const second = await watcherRegistry.runAll({});
    expect(second.alerts).toHaveLength(1);
  });

  test('disabled watcher does not fire', async () => {
    await watcherRegistry.register({ id: 'w', name: 'W', description: 'd', code: ALWAYS_TRIGGER });
    await watcherRegistry.setEnabled('w', false);
    const result = await watcherRegistry.runAll({});
    expect(result.alerts).toHaveLength(0);
  });
});

// ===========================================================================
// runAll — error handling
// ===========================================================================

describe('runAll — error handling', () => {
  test('records error for throwing watcher, runs remaining watchers', async () => {
    await watcherRegistry.register({ id: 'bad',  name: 'Bad',  description: 'd', code: THROWS_CODE });
    await watcherRegistry.register({ id: 'good', name: 'Good', description: 'd', code: ALWAYS_TRIGGER });

    const result = await watcherRegistry.runAll({});
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].watcher_id).toBe('bad');
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0].watcher_id).toBe('good');
  });

  test('non-object return treated as triggered:false', async () => {
    await watcherRegistry.register({ id: 'w', name: 'W', description: 'd', code: BAD_RETURN });
    const result = await watcherRegistry.runAll({});
    expect(result.alerts).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  test('null return treated as triggered:false', async () => {
    await watcherRegistry.register({ id: 'w', name: 'W', description: 'd', code: NULL_RETURN });
    const result = await watcherRegistry.runAll({});
    expect(result.alerts).toHaveLength(0);
  });

  test('enforces execution timeout', async () => {
    setConfig({ timeoutMs: 50, cooldownMinutes: 30 });
    await watcherRegistry.register({ id: 'loop', name: 'Loop', description: 'd', code: TIMEOUT_CODE });

    const result = await watcherRegistry.runAll({});
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/timed? ?out|Script execution timed out/i);
  });
});

// ===========================================================================
// VM sandbox isolation
// ===========================================================================

describe('VM sandbox isolation', () => {
  test('require is not accessible inside sandbox', async () => {
    await watcherRegistry.register({ id: 'req', name: 'R', description: 'd', code: NO_REQUIRE });
    const result = await watcherRegistry.runAll({});
    // triggered:true would mean require was accessible — it must NOT be
    const alert = result.alerts.find(a => a.watcher_id === 'req');
    expect(alert).toBeUndefined();
  });

  test('process is not accessible inside sandbox', async () => {
    await watcherRegistry.register({ id: 'proc', name: 'P', description: 'd', code: NO_PROCESS });
    const result = await watcherRegistry.runAll({});
    const alert  = result.alerts.find(a => a.watcher_id === 'proc');
    expect(alert).toBeUndefined();
  });

  test('mutations to status inside sandbox do not escape', async () => {
    await watcherRegistry.register({ id: 'mut', name: 'Mut', description: 'd', code: MUTATE_CODE });
    const snapshot = { store: { paused: false } };
    await watcherRegistry.runAll(snapshot);
    expect(snapshot.injected).toBeUndefined();
  });
});
