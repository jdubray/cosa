'use strict';

/**
 * Unit tests for src/tools/finix-latency-monitor.js
 *
 * Covers: log parsing (timeouts / slow / succeeded / 422 / max duration),
 * severity classification against thresholds (incl. min-sample rate guard),
 * and the SSH handler integration + not-connected guard.
 */

const mockIsConnected = jest.fn();
const mockExec        = jest.fn();
const mockGetConfig   = jest.fn();

jest.mock('../../src/ssh-backend', () => ({
  isConnected: (...a) => mockIsConnected(...a),
  exec:        (...a) => mockExec(...a),
}));
jest.mock('../../config/cosa.config', () => ({ getConfig: (...a) => mockGetConfig(...a) }));
jest.mock('../../src/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const tool = require('../../src/tools/finix-latency-monitor');
const { parseFinixLines, classifySeverity } = tool;

// Representative [finix-api] POST /transfers result lines (one per attempt).
const SUCCESS = (ms) => `{"ts":"2026-05-24T02:36:12.769Z","label":"[finix-api]","method":"POST","path":"/transfers","durationMs":${ms},"transferId":"TRabc","state":"SUCCEEDED","amountCents":2200,"deviceId":"DV4","orderId":null}`;
const TIMEOUT = `{"ts":"2026-05-24T01:38:18.770Z","label":"[finix-api]","method":"POST","path":"/transfers","durationMs":30001,"error":"The operation timed out.","amountCents":1987,"deviceId":"DV4","orderId":null}`;
const DUP422  = `{"ts":"2026-05-24T01:38:18.975Z","label":"[finix-api]","method":"POST","path":"/transfers","durationMs":205,"error":"Finix API error (422): Duplicate transfer TRdef already exists with idempotency ID ord_x-leg1-1779","amountCents":1987,"deviceId":"DV4","orderId":null}`;
const NOISE   = `<-- GET /api/merchants/m_69c917/orders?from=1779519600000&to=1779544500098`; // contains "500" but not a transfer

const DEFAULT_CFG = {
  enabled: true, window_minutes: 60, slow_call_ms: 10000,
  medium_timeout_count: 4, high_timeout_count: 10, medium_slow_count: 8,
  medium_rate_pct: 20, high_rate_pct: 40, min_sample: 5,
};
const withCfg = (over = {}) => mockGetConfig.mockReturnValue({
  appliance: { tools: { finix_latency_monitor: { ...DEFAULT_CFG, ...over } } },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockIsConnected.mockReturnValue(true);
  withCfg();
});

describe('parseFinixLines', () => {
  it('counts timeouts, slow calls, successes, 422 duplicates and max duration', () => {
    const stdout = [SUCCESS(1200), TIMEOUT, DUP422, SUCCESS(14000), NOISE, SUCCESS(900)].join('\n');
    const r = parseFinixLines(stdout, 10000);
    expect(r.transfer_calls).toBe(5);   // NOISE excluded (not a [finix-api] transfer)
    expect(r.timeouts).toBe(1);
    expect(r.succeeded).toBe(3);
    expect(r.duplicate_422).toBe(1);
    expect(r.slow_calls).toBe(1);       // the 14000ms success; the 30001ms is a timeout, not double-counted
    expect(r.max_duration_ms).toBe(30001);
  });

  it('returns all-zero on empty output', () => {
    expect(parseFinixLines('', 10000)).toEqual({
      transfer_calls: 0, timeouts: 0, slow_calls: 0, succeeded: 0, duplicate_422: 0, max_duration_ms: 0,
    });
  });
});

describe('classifySeverity', () => {
  const base = { transfer_calls: 50, timeouts: 0, slow_calls: 0 };
  it('none when under all thresholds', () => {
    expect(classifySeverity({ ...base, timeouts: 3 }, 6, DEFAULT_CFG)).toBe('none');
  });
  it('medium on timeout count', () => {
    expect(classifySeverity({ ...base, timeouts: 4 }, 8, DEFAULT_CFG)).toBe('medium');
  });
  it('medium on slow-call count', () => {
    expect(classifySeverity({ ...base, slow_calls: 8 }, 0, DEFAULT_CFG)).toBe('medium');
  });
  it('high on timeout count', () => {
    expect(classifySeverity({ ...base, timeouts: 10 }, 20, DEFAULT_CFG)).toBe('high');
  });
  it('high on rate when sample is sufficient', () => {
    expect(classifySeverity({ transfer_calls: 10, timeouts: 5, slow_calls: 0 }, 50, DEFAULT_CFG)).toBe('high');
  });
  it('ignores rate below min_sample (no 1/1 = 100% false alarm)', () => {
    expect(classifySeverity({ transfer_calls: 1, timeouts: 1, slow_calls: 0 }, 100, DEFAULT_CFG)).toBe('none');
  });
});

describe('handler', () => {
  it('throws when SSH is not connected', async () => {
    mockIsConnected.mockReturnValue(false);
    await expect(tool.handler({})).rejects.toThrow(/SSH not connected/);
  });

  it('reports none when transfers are healthy', async () => {
    mockExec.mockResolvedValue({ stdout: [SUCCESS(900), SUCCESS(1200)].join('\n'), stderr: '', exitCode: 0 });
    const res = await tool.handler({});
    expect(res.severity).toBe('none');
    expect(res.transfer_calls).toBe(2);
    expect(res.timeouts).toBe(0);
    expect(res.timeout_rate_pct).toBe(0);
  });

  it('flags high severity on a timeout spike and reports the rate', async () => {
    const lines = Array.from({ length: 6 }, () => SUCCESS(1000)).concat(Array.from({ length: 12 }, () => TIMEOUT));
    mockExec.mockResolvedValue({ stdout: lines.join('\n'), stderr: '', exitCode: 0 });
    const res = await tool.handler({});
    expect(res.severity).toBe('high');         // 12 timeouts >= high_timeout_count
    expect(res.timeouts).toBe(12);
    expect(res.transfer_calls).toBe(18);
    expect(res.timeout_rate_pct).toBe(67);
  });

  it('clamps an out-of-range window_minutes and still issues a safe command', async () => {
    withCfg({ window_minutes: 99999 });
    mockExec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    const res = await tool.handler({});
    expect(res.window_minutes).toBe(1440);     // clamped to max
    const cmd = mockExec.mock.calls[0][0];
    expect(cmd).toContain('--since "1440 minutes ago"');
    expect(cmd).toContain("grep -F '[finix-api]'");
  });
});
