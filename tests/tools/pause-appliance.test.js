'use strict';

/**
 * Unit tests for src/tools/pause-appliance.js
 *
 * Acceptance Criteria covered:
 *   AC1 — supports supervisor: 'pm2' | 'systemd' from config
 *   AC2 — executes pm2 stop or systemctl stop for the configured service name
 *   AC3 — verifies service is stopped by checking the health endpoint
 *   AC4 — returns success, supervisor, verificationPass, timestamp
 *   AC5 — risk level is 'critical'
 *   AC6 — stop command failure is captured in the return value (no throw)
 */

// ---------------------------------------------------------------------------
// Mocks — hoisted before any require()
// ---------------------------------------------------------------------------

const mockExec      = jest.fn();
const mockGetConfig = jest.fn();
const mockFetch     = jest.fn();

jest.mock('../../src/ssh-backend', () => ({
  exec: (...a) => mockExec(...a),
}));

jest.mock('../../config/cosa.config', () => ({
  getConfig: (...a) => mockGetConfig(...a),
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

const { handler, riskLevel, name } = require('../../src/tools/pause-appliance');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Build a minimal config for the handler.
 * @param {'systemd'|'pm2'} supervisorType
 * @param {string} [serviceName]
 */
function makeConfig(supervisorType, serviceName = 'weather-station') {
  return {
    appliance: {
      process_supervisor: { type: supervisorType, service_name: serviceName },
      appliance_api: {
        base_url:           'http://192.168.1.10:3000',
        health_endpoint:    '/health',
        request_timeout_ms: 5000,
      },
    },
  };
}

/** Mock fetch: health endpoint unreachable (ECONNREFUSED). */
function mockHealthUnreachable() {
  mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
}

/** Mock fetch: health endpoint still responds with 200. */
function mockHealthReachable(status = 200) {
  mockFetch.mockResolvedValueOnce({
    status,
    json: jest.fn().mockResolvedValue({ status: 'ok' }),
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  global.fetch = mockFetch;
  mockFetch.mockReset();
  mockExec.mockReset();
  mockGetConfig.mockReturnValue(makeConfig('systemd'));
  mockExec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  mockHealthUnreachable(); // default: stop succeeded, service gone
});

afterEach(() => {
  delete global.fetch;
});

// ---------------------------------------------------------------------------
// AC5 — module metadata
// ---------------------------------------------------------------------------

describe('AC5 — module metadata', () => {
  it('exports name = pause_appliance', () => {
    expect(name).toBe('pause_appliance');
  });

  it('exports riskLevel = critical', () => {
    expect(riskLevel).toBe('critical');
  });
});

// ---------------------------------------------------------------------------
// AC1 + AC2 — supervisor type dispatches correct stop command
// ---------------------------------------------------------------------------

describe('AC1+AC2 — correct stop command per supervisor type', () => {
  it('executes systemctl stop <service> for systemd supervisor', async () => {
    mockGetConfig.mockReturnValue(makeConfig('systemd', 'weather-station'));
    await handler();
    expect(mockExec).toHaveBeenCalledWith('systemctl stop weather-station');
  });

  it('executes pm2 stop <service> for pm2 supervisor', async () => {
    mockGetConfig.mockReturnValue(makeConfig('pm2', 'weather-station'));
    await handler();
    expect(mockExec).toHaveBeenCalledWith('pm2 stop weather-station');
  });

  it('uses the configured service_name in the stop command', async () => {
    mockGetConfig.mockReturnValue(makeConfig('systemd', 'baanbaan'));
    await handler();
    expect(mockExec).toHaveBeenCalledWith('systemctl stop baanbaan');
  });

  it('uses the configured service_name with pm2', async () => {
    mockGetConfig.mockReturnValue(makeConfig('pm2', 'my-app'));
    await handler();
    expect(mockExec).toHaveBeenCalledWith('pm2 stop my-app');
  });

  it('rejects service names with shell-injectable characters', async () => {
    mockGetConfig.mockReturnValue(makeConfig('systemd', 'bad; rm -rf /'));
    const result = await handler();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid service name/i);
  });

  it('accepts service names with hyphens and dots', async () => {
    mockGetConfig.mockReturnValue(makeConfig('systemd', 'my-app.service'));
    await handler();
    expect(mockExec).toHaveBeenCalledWith('systemctl stop my-app.service');
  });
});

// ---------------------------------------------------------------------------
// AC3 — health endpoint verification after stop
// ---------------------------------------------------------------------------

describe('AC3 — health endpoint verification', () => {
  it('calls the configured health URL after the stop command', async () => {
    await handler();
    expect(mockFetch).toHaveBeenCalledWith(
      'http://192.168.1.10:3000/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('verificationPass is true when health endpoint is unreachable', async () => {
    mockFetch.mockReset();
    mockHealthUnreachable();
    const result = await handler();
    expect(result.verificationPass).toBe(true);
  });

  it('verificationPass is false when health endpoint is still reachable', async () => {
    mockFetch.mockReset();
    mockHealthReachable(200);
    const result = await handler();
    expect(result.verificationPass).toBe(false);
  });

  it('health_after.reachable is false when endpoint is unreachable', async () => {
    const result = await handler();
    expect(result.health_after.reachable).toBe(false);
  });

  it('health_after.reachable is true and includes status_code when still up', async () => {
    mockFetch.mockReset();
    mockHealthReachable(200);
    const result = await handler();
    expect(result.health_after.reachable).toBe(true);
    expect(result.health_after.status_code).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// AC4 — return shape
// ---------------------------------------------------------------------------

describe('AC4 — return shape', () => {
  it('result has success (boolean)', async () => {
    const result = await handler();
    expect(typeof result.success).toBe('boolean');
  });

  it('result has supervisor matching config type', async () => {
    mockGetConfig.mockReturnValue(makeConfig('pm2'));
    mockFetch.mockReset();
    mockHealthUnreachable();
    const result = await handler();
    expect(result.supervisor).toBe('pm2');
  });

  it('result has service_name matching config', async () => {
    mockGetConfig.mockReturnValue(makeConfig('systemd', 'baanbaan'));
    mockFetch.mockReset();
    mockHealthUnreachable();
    const result = await handler();
    expect(result.service_name).toBe('baanbaan');
  });

  it('result has verificationPass (boolean)', async () => {
    const result = await handler();
    expect(typeof result.verificationPass).toBe('boolean');
  });

  it('result has stop_issued_at as ISO 8601 timestamp', async () => {
    const result = await handler();
    expect(() => new Date(result.stop_issued_at).toISOString()).not.toThrow();
  });

  it('result has health_after object', async () => {
    const result = await handler();
    expect(result).toHaveProperty('health_after');
    expect(typeof result.health_after).toBe('object');
  });

  it('success is true when stop succeeds AND health is unreachable', async () => {
    const result = await handler();
    expect(result.success).toBe(true);
  });

  it('success is false when health endpoint still responds after stop', async () => {
    mockFetch.mockReset();
    mockHealthReachable(200);
    const result = await handler();
    expect(result.success).toBe(false);
  });

  it('error field is set when health still reachable', async () => {
    mockFetch.mockReset();
    mockHealthReachable(200);
    const result = await handler();
    expect(typeof result.error).toBe('string');
    expect(result.error).toMatch(/still appears reachable/i);
  });

  it('no error field (or undefined) when fully successful', async () => {
    const result = await handler();
    expect(result.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC6 — stop command failure is captured, not thrown
// ---------------------------------------------------------------------------

describe('AC6 — stop command failures are returned, not thrown', () => {
  it('returns success: false when stop command exits non-zero', async () => {
    mockExec.mockResolvedValue({ stdout: '', stderr: 'unit not found', exitCode: 1 });
    const result = await handler();
    expect(result.success).toBe(false);
    expect(result.verificationPass).toBe(false);
  });

  it('error field contains the failure message', async () => {
    mockExec.mockResolvedValue({ stdout: '', stderr: 'unit not found', exitCode: 5 });
    const result = await handler();
    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
  });

  it('does not call health endpoint when stop command fails', async () => {
    mockExec.mockResolvedValue({ stdout: '', stderr: 'failed', exitCode: 1 });
    mockFetch.mockReset();
    await handler();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('result still contains supervisor and service_name on stop failure', async () => {
    mockExec.mockResolvedValue({ stdout: '', stderr: 'error', exitCode: 2 });
    const result = await handler();
    expect(result.supervisor).toBe('systemd');
    expect(result.service_name).toBe('weather-station');
  });

  it('handler never throws — wraps all errors in result object', async () => {
    mockGetConfig.mockReturnValue(makeConfig('systemd', 'bad; rm -rf /'));
    await expect(handler()).resolves.toMatchObject({ success: false });
  });
});
