'use strict';

jest.mock('../config/cosa.config');
jest.mock('../src/appliance-auth');
jest.mock('../src/ssh-backend');
jest.mock('../src/watcher-registry');
jest.mock('../src/session-store', () => ({ createAlert: jest.fn() }));
jest.mock('../src/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }),
}));

const { getConfig }         = require('../config/cosa.config');
const { withApplianceAuth } = require('../src/appliance-auth');
const sshBackend            = require('../src/ssh-backend');
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
  // The poll now curls the appliance loopback over SSH (Cloudflare blocks
  // /api/status at the edge), so mock sshBackend.exec returning curl's
  // body + the HTTP_STATUS=<code> suffix the tool parses.
  withApplianceAuth.mockImplementation(async (apiFn) => apiFn({ Authorization: 'Bearer test-token' }));
  sshBackend.exec = jest.fn().mockResolvedValue({
    stdout:   `${JSON.stringify(body)}
HTTP_STATUS=${status}`,
    stderr:   '',
    exitCode: 0,
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
  watcherRegistry.runAll = jest.fn().mockResolvedValue({ alerts: [], errors: [], watchers_evaluated: 0 });
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

  test('curls the appliance loopback status endpoint over SSH', async () => {
    mockHttpSuccess();

    await handler({});

    const cmd = sshBackend.exec.mock.calls[0][0];
    expect(cmd).toMatch(/curl/);
    expect(cmd).toContain('/api/status');
    expect(cmd).toContain('127.0.0.1:3000');
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
      alerts:             [{ watcher_id: 'w' }],
      errors:             [{ watcher_id: 'x' }],
      watchers_evaluated: 2,
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

  test('treats a missing HTTP_STATUS line as a network error (not a fake 200)', async () => {
    // curl can resolve with exitCode 0 but no status line (connection refused
    // on loopback, or killed by --max-time). The tool must surface this rather
    // than reporting success with a null body.
    withApplianceAuth.mockImplementation(async (apiFn) => apiFn({ Authorization: 'Bearer test-token' }));
    sshBackend.exec = jest.fn().mockResolvedValue({ stdout: 'curl: (7) Connection refused', stderr: '', exitCode: 0 });

    const result = await handler({});

    expect(result.success).toBe(false);
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
    withApplianceAuth.mockImplementation(async (apiFn) => apiFn({ Authorization: 'Bearer test-token' }));
    sshBackend.exec = jest.fn().mockResolvedValue({
      stdout:   `${JSON.stringify(SNAPSHOT)}
HTTP_STATUS=200`,
      stderr:   '',
      exitCode: 0,
    });

    await handler({});

    const cmd = sshBackend.exec.mock.calls[0][0];
    expect(cmd).toContain('/api/status');
  });
});

// ---------------------------------------------------------------------------
// Hardening: shell-escape interpolated curl args (2026-05-22 security review)
// ---------------------------------------------------------------------------

const { shEscape } = require('../src/shell-utils');

describe('fetchStatus — shell-escapes interpolated values', () => {
  it('a single quote in the bearer token is escaped, not a shell break-out', async () => {
    // Hypothetical quote-bearing token: must be neutralised inside the
    // single-quoted curl arg so it cannot terminate the quoting / inject.
    withApplianceAuth.mockImplementation(async (apiFn) => apiFn({ Authorization: "Bearer ab'cd" }));
    sshBackend.exec = jest.fn().mockResolvedValue({
      stdout: `${JSON.stringify(SNAPSHOT)}\nHTTP_STATUS=200`, stderr: '', exitCode: 0,
    });

    await handler({});

    const cmd = sshBackend.exec.mock.calls[0][0];
    // The header value appears as shEscape()'s own output, wrapped in quotes …
    const escapedHeader = shEscape("Authorization: Bearer ab'cd");
    expect(cmd).toContain(`'${escapedHeader}'`);
    expect(escapedHeader).not.toEqual("Authorization: Bearer ab'cd"); // proves escaping happened
    // … and never the bare break-out form (a dangling quote right after token).
    expect(cmd).not.toContain("Authorization: Bearer ab'cd'");
  });
});
