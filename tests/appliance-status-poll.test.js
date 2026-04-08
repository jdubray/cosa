'use strict';

jest.mock('../config/cosa.config');
jest.mock('../src/appliance-auth');
jest.mock('../src/watcher-registry');
jest.mock('../src/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }),
}));

const { getConfig }         = require('../config/cosa.config');
const { withApplianceAuth } = require('../src/appliance-auth');
const watcherRegistry       = require('../src/watcher-registry');
const { handler }           = require('../src/tools/appliance-status-poll');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_URL        = 'http://appliance.local:3000';
const STATUS_ENDPOINT = '/api/status';
const TIMEOUT_MS      = 10000;

const SNAPSHOT = {
  store:    { paused: false, online_ordering: true },
  orders:   { pending: 3, preparing: 1, ready: 0 },
  hardware: { printer: { status: 'ok' } },
  system:   { uptime_s: 84600, db: 'ok', version: '1.4.2' },
};

function setConfig(overrides = {}) {
  getConfig.mockReturnValue({
    appliance: {
      appliance_api: {
        base_url:           BASE_URL,
        status_endpoint:    STATUS_ENDPOINT,
        request_timeout_ms: TIMEOUT_MS,
        ...overrides,
      },
    },
  });
}

/**
 * Configure withApplianceAuth to transparently invoke apiFn with empty headers,
 * and have global.fetch return the given HTTP response.
 */
function mockHttpSuccess({ status = 200, body = SNAPSHOT } = {}) {
  withApplianceAuth.mockImplementation(async (apiFn) => apiFn({}));
  global.fetch = jest.fn().mockResolvedValue({
    status,
    ok:   status >= 200 && status < 300,
    json: async () => body,
  });
}

function mockAuthError(code = 'APPLIANCE_NETWORK_ERROR', message = 'timeout') {
  withApplianceAuth.mockRejectedValue(Object.assign(new Error(message), { code }));
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  setConfig();
  watcherRegistry.runAll = jest.fn().mockResolvedValue({ alerts: [], errors: [] });
});

afterEach(() => {
  delete global.fetch;
});

// ===========================================================================
// AC1 — successful poll returns snapshot
// ===========================================================================

describe('AC1 — successful poll returns snapshot', () => {
  test('returns success:true with snapshot and empty alerts', async () => {
    mockHttpSuccess();

    const result = await handler({});

    expect(result.success).toBe(true);
    expect(result.snapshot).toEqual(SNAPSHOT);
    expect(result.alerts).toEqual([]);
    expect(result.polled_at).toBeTruthy();
  });

  test('calls correct URL', async () => {
    mockHttpSuccess();

    await handler({});

    expect(global.fetch).toHaveBeenCalledWith(
      `${BASE_URL}${STATUS_ENDPOINT}`,
      expect.any(Object)
    );
  });

  test('includes watchers_run count', async () => {
    mockHttpSuccess();

    const result = await handler({});

    expect(typeof result.watchers_run).toBe('number');
  });
});

// ===========================================================================
// AC2 — skip_watchers: true
// ===========================================================================

describe('AC2 — skip_watchers', () => {
  test('does not call runAll when skip_watchers is true', async () => {
    mockHttpSuccess();

    await handler({ skip_watchers: true });

    expect(watcherRegistry.runAll).not.toHaveBeenCalled();
  });

  test('returns snapshot with watchers_run: 0 when skipped', async () => {
    mockHttpSuccess();

    const result = await handler({ skip_watchers: true });

    expect(result.success).toBe(true);
    expect(result.watchers_run).toBe(0);
    expect(result.snapshot).toEqual(SNAPSHOT);
  });
});

// ===========================================================================
// AC3 — watcher alerts surface in result
// ===========================================================================

describe('AC3 — watcher alerts', () => {
  test('includes triggered alerts in result', async () => {
    mockHttpSuccess();
    const firedAlert = {
      watcher_id:   'printer_fault',
      watcher_name: 'Printer fault or absent',
      message:      'Printer is fault',
      triggered_at: new Date().toISOString(),
    };
    watcherRegistry.runAll.mockResolvedValue({ alerts: [firedAlert], errors: [] });

    const result = await handler({});

    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]).toMatchObject({
      watcher_id:   'printer_fault',
      watcher_name: 'Printer fault or absent',
      message:      'Printer is fault',
    });
  });

  test('watchers_run reflects alerts + errors count', async () => {
    mockHttpSuccess();
    watcherRegistry.runAll.mockResolvedValue({
      alerts: [{ watcher_id: 'w' }],
      errors: [{ watcher_id: 'x' }],
    });

    const result = await handler({});

    expect(result.watchers_run).toBe(2);
  });

  test('passes snapshot to runAll', async () => {
    mockHttpSuccess();

    await handler({});

    expect(watcherRegistry.runAll).toHaveBeenCalledWith(SNAPSHOT);
  });
});

// ===========================================================================
// AC4 — network / auth errors
// ===========================================================================

describe('AC4 — network and auth errors', () => {
  test('returns success:false on APPLIANCE_NETWORK_ERROR', async () => {
    mockAuthError('APPLIANCE_NETWORK_ERROR', 'Request timed out after 10000ms');

    const result = await handler({});

    expect(result.success).toBe(false);
    expect(result.snapshot).toBeNull();
    expect(result.error).toContain('timed out');
    expect(result.code).toBe('APPLIANCE_NETWORK_ERROR');
  });

  test('returns success:false on APPLIANCE_AUTH_FAILED', async () => {
    mockAuthError('APPLIANCE_AUTH_FAILED', 'All authentication attempts failed');

    const result = await handler({});

    expect(result.success).toBe(false);
    expect(result.code).toBe('APPLIANCE_AUTH_FAILED');
  });

  test('includes polled_at even on error', async () => {
    mockAuthError();

    const result = await handler({});

    expect(result.polled_at).toBeTruthy();
  });
});

// ===========================================================================
// AC5 — non-2xx HTTP status
// ===========================================================================

describe('AC5 — non-2xx HTTP response', () => {
  test('returns success:false with APPLIANCE_HTTP_ERROR on 503', async () => {
    withApplianceAuth.mockResolvedValue({ status: 503, body: { error: 'service unavailable' } });

    const result = await handler({});

    expect(result.success).toBe(false);
    expect(result.code).toBe('APPLIANCE_HTTP_ERROR');
    expect(result.status_code).toBe(503);
  });
});

// ===========================================================================
// AC6 — config defaults
// ===========================================================================

describe('AC6 — config defaults', () => {
  test('uses /api/status when status_endpoint not configured', async () => {
    getConfig.mockReturnValue({
      appliance: {
        appliance_api: { base_url: BASE_URL, request_timeout_ms: TIMEOUT_MS },
      },
    });
    withApplianceAuth.mockImplementation(async (apiFn) => apiFn({}));
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => SNAPSHOT,
    });

    await handler({});

    const url = global.fetch.mock.calls[0][0];
    expect(url).toContain('/api/status');
  });
});
