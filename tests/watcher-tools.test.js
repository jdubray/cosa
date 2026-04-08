'use strict';

/**
 * Unit tests for the four watcher management tools:
 *   watcher_register, watcher_list, watcher_remove, watcher_set_enabled
 *
 * The watcher-registry module is mocked so these tests focus purely on
 * the tool handler logic — input forwarding, output shaping, and error paths.
 */

jest.mock('../src/watcher-registry');

const watcherRegistry = require('../src/watcher-registry');

const registerTool    = require('../src/tools/watcher-register');
const listTool        = require('../src/tools/watcher-list');
const removeTool      = require('../src/tools/watcher-remove');
const setEnabledTool  = require('../src/tools/watcher-set-enabled');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function registryError(message, code) {
  const err  = new Error(message);
  err.code   = code;
  return err;
}

// ---------------------------------------------------------------------------
// watcher_register
// ---------------------------------------------------------------------------

describe('watcher_register tool', () => {
  beforeEach(() => jest.clearAllMocks());

  test('exports correct name and riskLevel', () => {
    expect(registerTool.name).toBe('watcher_register');
    expect(registerTool.riskLevel).toBe('medium');
  });

  test('schema requires id, name, description, code', () => {
    const { required } = registerTool.schema.inputSchema;
    expect(required).toEqual(expect.arrayContaining(['id', 'name', 'description', 'code']));
  });

  test('happy path — returns success with id and name', async () => {
    watcherRegistry.register.mockResolvedValue(undefined);

    const result = await registerTool.handler({
      id:          'printer_fault',
      name:        'Printer fault',
      description: 'Alert when printer is offline',
      code:        'function watch(status) { return { triggered: false }; }',
    });

    expect(result.success).toBe(true);
    expect(result.id).toBe('printer_fault');
    expect(result.name).toBe('Printer fault');
    expect(typeof result.message).toBe('string');
    expect(watcherRegistry.register).toHaveBeenCalledWith({
      id:          'printer_fault',
      name:        'Printer fault',
      description: 'Alert when printer is offline',
      code:        'function watch(status) { return { triggered: false }; }',
    });
  });

  test('validation error — WATCHER_INVALID propagated', async () => {
    watcherRegistry.register.mockRejectedValue(
      registryError('Invalid watcher id', 'WATCHER_INVALID')
    );

    const result = await registerTool.handler({
      id: 'BAD ID', name: 'x', description: 'x', code: 'function watch() {}',
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('WATCHER_INVALID');
    expect(typeof result.error).toBe('string');
  });

  test('unexpected error — code defaults to WATCHER_REGISTER_FAILED', async () => {
    watcherRegistry.register.mockRejectedValue(new Error('disk full'));

    const result = await registerTool.handler({
      id: 'ok_id', name: 'x', description: 'x', code: 'function watch() {}',
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('WATCHER_REGISTER_FAILED');
  });
});

// ---------------------------------------------------------------------------
// watcher_list
// ---------------------------------------------------------------------------

describe('watcher_list tool', () => {
  beforeEach(() => jest.clearAllMocks());

  test('exports correct name and riskLevel', () => {
    expect(listTool.name).toBe('watcher_list');
    expect(listTool.riskLevel).toBe('read');
  });

  test('happy path — returns count and mapped watcher rows', async () => {
    watcherRegistry.list.mockResolvedValue([
      {
        id: 'printer_fault', name: 'Printer fault', description: 'desc',
        enabled: 1, trigger_count: 3,
        last_triggered_at: '2026-04-01T10:00:00.000Z',
        last_alerted_at:   '2026-04-01T10:00:00.000Z',
        created_at:        '2026-03-01T00:00:00.000Z',
      },
    ]);

    const result = await listTool.handler({});

    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(result.watchers).toHaveLength(1);

    const w = result.watchers[0];
    expect(w.id).toBe('printer_fault');
    expect(w.enabled).toBe(true);          // 1 → boolean true
    expect(w.trigger_count).toBe(3);
  });

  test('disabled watcher has enabled:false', async () => {
    watcherRegistry.list.mockResolvedValue([
      {
        id: 'disabled_watcher', name: 'Disabled', description: 'x',
        enabled: 0, trigger_count: 0,
        last_triggered_at: null, last_alerted_at: null,
        created_at: '2026-03-01T00:00:00.000Z',
      },
    ]);

    const result = await listTool.handler({});
    expect(result.watchers[0].enabled).toBe(false);
  });

  test('empty registry returns count:0 and empty array', async () => {
    watcherRegistry.list.mockResolvedValue([]);

    const result = await listTool.handler({});
    expect(result.success).toBe(true);
    expect(result.count).toBe(0);
    expect(result.watchers).toEqual([]);
  });

  test('code field omitted by default (no show_code)', async () => {
    watcherRegistry.list.mockResolvedValue([
      {
        id: 'w1', name: 'n', description: 'd', code: 'function w() {}',
        enabled: 1, trigger_count: 0,
        last_triggered_at: null, last_alerted_at: null,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const result = await listTool.handler({});
    expect(result.watchers[0]).not.toHaveProperty('code');
  });

  test('show_code:true includes code in each entry', async () => {
    watcherRegistry.list.mockResolvedValue([
      {
        id: 'w1', name: 'n', description: 'd', code: 'function w(s) { return { triggered: false }; }',
        enabled: 1, trigger_count: 0,
        last_triggered_at: null, last_alerted_at: null,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const result = await listTool.handler({ show_code: true });
    expect(result.watchers[0].code).toBe('function w(s) { return { triggered: false }; }');
  });

  test('null timestamps are preserved as null', async () => {
    watcherRegistry.list.mockResolvedValue([
      {
        id: 'w1', name: 'n', description: 'd', enabled: 1, trigger_count: 0,
        last_triggered_at: null, last_alerted_at: null,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const result = await listTool.handler({});
    expect(result.watchers[0].last_triggered_at).toBeNull();
    expect(result.watchers[0].last_alerted_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// watcher_remove
// ---------------------------------------------------------------------------

describe('watcher_remove tool', () => {
  beforeEach(() => jest.clearAllMocks());

  test('exports correct name and riskLevel', () => {
    expect(removeTool.name).toBe('watcher_remove');
    expect(removeTool.riskLevel).toBe('medium');
  });

  test('schema requires id only', () => {
    const { required, additionalProperties } = removeTool.schema.inputSchema;
    expect(required).toEqual(['id']);
    expect(additionalProperties).toBe(false);
  });

  test('happy path — returns success and id', async () => {
    watcherRegistry.remove.mockResolvedValue(undefined);

    const result = await removeTool.handler({ id: 'printer_fault' });

    expect(result.success).toBe(true);
    expect(result.id).toBe('printer_fault');
    expect(typeof result.message).toBe('string');
    expect(watcherRegistry.remove).toHaveBeenCalledWith('printer_fault');
  });

  test('not-found error is propagated', async () => {
    watcherRegistry.remove.mockRejectedValue(
      registryError('Watcher "ghost" not found', 'WATCHER_NOT_FOUND')
    );

    const result = await removeTool.handler({ id: 'ghost' });

    expect(result.success).toBe(false);
    expect(result.code).toBe('WATCHER_NOT_FOUND');
  });

  test('unexpected error — code defaults to WATCHER_REMOVE_FAILED', async () => {
    watcherRegistry.remove.mockRejectedValue(new Error('db locked'));

    const result = await removeTool.handler({ id: 'some_id' });

    expect(result.success).toBe(false);
    expect(result.code).toBe('WATCHER_REMOVE_FAILED');
  });
});

// ---------------------------------------------------------------------------
// watcher_set_enabled
// ---------------------------------------------------------------------------

describe('watcher_set_enabled tool', () => {
  beforeEach(() => jest.clearAllMocks());

  test('exports correct name and riskLevel', () => {
    expect(setEnabledTool.name).toBe('watcher_set_enabled');
    expect(setEnabledTool.riskLevel).toBe('read');
  });

  test('schema requires id and enabled', () => {
    const { required } = setEnabledTool.schema.inputSchema;
    expect(required).toEqual(expect.arrayContaining(['id', 'enabled']));
  });

  test('enable — returns success with enabled:true', async () => {
    watcherRegistry.setEnabled.mockResolvedValue(undefined);

    const result = await setEnabledTool.handler({ id: 'printer_fault', enabled: true });

    expect(result.success).toBe(true);
    expect(result.id).toBe('printer_fault');
    expect(result.enabled).toBe(true);
    expect(result.message).toMatch(/enabled/);
    expect(watcherRegistry.setEnabled).toHaveBeenCalledWith('printer_fault', true);
  });

  test('disable — returns success with enabled:false and "disabled" in message', async () => {
    watcherRegistry.setEnabled.mockResolvedValue(undefined);

    const result = await setEnabledTool.handler({ id: 'printer_fault', enabled: false });

    expect(result.success).toBe(true);
    expect(result.enabled).toBe(false);
    expect(result.message).toMatch(/disabled/);
  });

  test('not-found error is propagated with original code', async () => {
    watcherRegistry.setEnabled.mockRejectedValue(
      registryError('Watcher "ghost" not found', 'WATCHER_NOT_FOUND')
    );

    const result = await setEnabledTool.handler({ id: 'ghost', enabled: true });

    expect(result.success).toBe(false);
    expect(result.code).toBe('WATCHER_NOT_FOUND');
  });

  test('unexpected error — code defaults to WATCHER_SET_ENABLED_FAILED', async () => {
    watcherRegistry.setEnabled.mockRejectedValue(new Error('unexpected'));

    const result = await setEnabledTool.handler({ id: 'some_id', enabled: true });

    expect(result.success).toBe(false);
    expect(result.code).toBe('WATCHER_SET_ENABLED_FAILED');
  });
});
