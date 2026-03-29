'use strict';

// ---------------------------------------------------------------------------
// Mocks — all declared with the `mock` prefix so Jest's hoist exemption
// applies and they can be referenced inside jest.mock() factory bodies.
// ---------------------------------------------------------------------------

const mockIsConnected = jest.fn();
const mockExec        = jest.fn();
const mockGetConfig   = jest.fn();
const mockFetch       = jest.fn();

jest.mock('../../src/ssh-backend', () => ({
  isConnected: (...a) => mockIsConnected(...a),
  exec:        (...a) => mockExec(...a),
}));

jest.mock('../../config/cosa.config', () => ({
  getConfig: (...a) => mockGetConfig(...a),
}));

// ---------------------------------------------------------------------------
// Module under test (required AFTER mocks are set up)
// ---------------------------------------------------------------------------

const { handler } = require('../../src/tools/health-check');

// ---------------------------------------------------------------------------
// Config + response fixtures
// ---------------------------------------------------------------------------

const BASE_CONFIG = {
  appliance: {
    appliance_api: {
      base_url:              'http://192.168.1.10:3000',
      health_endpoint:       '/health',
      health_ready_endpoint: '/health/ready',
      request_timeout_ms:    10000,
    },
  },
};

/** Build a minimal fetch Response mock. */
function mockResponse(status, body) {
  return {
    status,
    json: body !== null
      ? jest.fn().mockResolvedValue(body)
      : jest.fn().mockRejectedValue(new Error('not JSON')),
  };
}

/** Healthy systemctl stdout. */
const HEALTHY_SYSTEMCTL =
  'ActiveState=active\nSubState=running\n' +
  'ExecMainStartTimestamp=Mon 2024-01-15 10:30:00 UTC\nNRestarts=0\n';

/** Systemctl output showing the service has restarted once. */
const RESTARTED_SYSTEMCTL =
  'ActiveState=active\nSubState=running\n' +
  'ExecMainStartTimestamp=Mon 2024-01-15 10:30:00 UTC\nNRestarts=1\n';

/** Systemctl output for a stopped service. */
const STOPPED_SYSTEMCTL =
  'ActiveState=inactive\nSubState=dead\n' +
  'ExecMainStartTimestamp=\nNRestarts=0\n';

// ---------------------------------------------------------------------------
// Lifecycle helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockGetConfig.mockReturnValue(BASE_CONFIG);

  // Default: SSH connected, healthy HTTP, healthy process
  mockIsConnected.mockReturnValue(true);
  mockExec.mockResolvedValue({ stdout: HEALTHY_SYSTEMCTL, stderr: '', exitCode: 0 });

  // Install mock fetch globally
  global.fetch = mockFetch;
  mockFetch
    .mockResolvedValueOnce(mockResponse(200, { ok: true }))   // /health
    .mockResolvedValueOnce(mockResponse(200, { ready: true })); // /health/ready
});

afterEach(() => {
  jest.clearAllMocks();
  delete global.fetch;
});

// ---------------------------------------------------------------------------
// AC1 — SSH connectivity check runs first; subsequent steps depend on it
// ---------------------------------------------------------------------------

describe('AC1 — SSH connectivity prerequisite', () => {
  it('polls isConnected() before making HTTP calls', async () => {
    const callOrder = [];
    mockIsConnected.mockImplementation(() => { callOrder.push('ssh'); return true; });
    mockFetch.mockImplementation(async () => { callOrder.push('http'); return mockResponse(200, { ok: true }); });

    await handler();

    expect(callOrder[0]).toBe('ssh');
  });

  it('skips the systemctl step when SSH is not connected', async () => {
    mockIsConnected.mockReturnValue(false);
    mockFetch
      .mockResolvedValueOnce(mockResponse(200, { ok: true }))
      .mockResolvedValueOnce(mockResponse(200, { ready: true }));

    const result = await handler();

    expect(mockExec).not.toHaveBeenCalled();
    expect(result.process).toBeNull();
  });

  it('retries isConnected() up to 3 times on failure before giving up', async () => {
    jest.useFakeTimers();
    mockIsConnected.mockReturnValue(false);
    mockFetch
      .mockResolvedValueOnce(mockResponse(200, { ok: true }))
      .mockResolvedValueOnce(mockResponse(200, { ready: true }));

    const p = handler();
    // Advance through all three 2-second retry delays
    await jest.runAllTimersAsync();
    await p;

    // isConnected is called once on entry + once per retry = 4 total
    expect(mockIsConnected).toHaveBeenCalledTimes(4);
    jest.useRealTimers();
  });

  it('succeeds on a retry without exhausting all attempts', async () => {
    jest.useFakeTimers();
    // First call returns false, second returns true
    mockIsConnected.mockReturnValueOnce(false).mockReturnValue(true);
    mockFetch
      .mockResolvedValueOnce(mockResponse(200, { ok: true }))
      .mockResolvedValueOnce(mockResponse(200, { ready: true }));

    const p = handler();
    await jest.runAllTimersAsync();
    const result = await p;

    expect(result.ssh_connected).toBe(true);
    jest.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// AC2 — HTTP GET /health with 10s timeout
// ---------------------------------------------------------------------------

describe('AC2 — HTTP GET /health', () => {
  it('calls fetch with the correct /health URL', async () => {
    await handler();
    expect(mockFetch).toHaveBeenCalledWith(
      'http://192.168.1.10:3000/health',
      expect.objectContaining({ signal: expect.any(Object) })
    );
  });

  it('sets reachable: false when fetch throws (network error)', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('Network error')) // /health fails
      .mockResolvedValueOnce(mockResponse(200, { ready: true }));

    const result = await handler();
    expect(result.http_health.reachable).toBe(false);
    expect(result.http_health.status_code).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC3 — HTTP GET /health/ready with 10s timeout
// ---------------------------------------------------------------------------

describe('AC3 — HTTP GET /health/ready', () => {
  it('calls fetch with the correct /health/ready URL', async () => {
    await handler();
    expect(mockFetch).toHaveBeenCalledWith(
      'http://192.168.1.10:3000/health/ready',
      expect.objectContaining({ signal: expect.any(Object) })
    );
  });

  it('sets reachable: false when fetch throws for /health/ready', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(200, { ok: true }))
      .mockRejectedValueOnce(new Error('timeout'));

    const result = await handler();
    expect(result.http_ready.reachable).toBe(false);
  });

  it('runs /health and /health/ready in parallel', async () => {
    const callUrls = [];
    mockFetch.mockImplementation(async (url) => {
      callUrls.push(url);
      return mockResponse(200, { ok: true, ready: true });
    });

    await handler();

    // Both URLs must appear (order may vary since they run in parallel)
    expect(callUrls).toContain('http://192.168.1.10:3000/health');
    expect(callUrls).toContain('http://192.168.1.10:3000/health/ready');
  });
});

// ---------------------------------------------------------------------------
// AC4 — systemctl show command
// ---------------------------------------------------------------------------

describe('AC4 — systemctl show via SSH', () => {
  it('runs the systemctl show command with the correct properties', async () => {
    await handler();
    expect(mockExec).toHaveBeenCalledWith(
      'systemctl show baanbaan --property=ActiveState,SubState,ExecMainStartTimestamp,NRestarts'
    );
  });
});

// ---------------------------------------------------------------------------
// AC5 — key=value parse and uptime_seconds computation
// ---------------------------------------------------------------------------

describe('AC5 — systemctl output parsing', () => {
  it('parses ActiveState, SubState, and NRestarts', async () => {
    const result = await handler();
    expect(result.process.active_state).toBe('active');
    expect(result.process.sub_state).toBe('running');
    expect(result.process.restarts).toBe(0);
  });

  it('computes uptime_seconds as a positive integer', async () => {
    const result = await handler();
    expect(typeof result.process.uptime_seconds).toBe('number');
    expect(result.process.uptime_seconds).toBeGreaterThan(0);
  });

  it('converts ExecMainStartTimestamp to ISO 8601 started_at', async () => {
    const result = await handler();
    expect(result.process.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('sets started_at and uptime_seconds to null when timestamp is empty', async () => {
    mockExec.mockResolvedValue({ stdout: STOPPED_SYSTEMCTL, stderr: '', exitCode: 0 });
    const result = await handler();
    expect(result.process.started_at).toBeNull();
    expect(result.process.uptime_seconds).toBeNull();
  });

  it('handles the weekday prefix in systemd timestamp format', async () => {
    const stdout =
      'ActiveState=active\nSubState=running\n' +
      'ExecMainStartTimestamp=Fri 2025-06-06 08:00:00 UTC\nNRestarts=0\n';
    mockExec.mockResolvedValue({ stdout, stderr: '', exitCode: 0 });
    const result = await handler();
    expect(result.process.started_at).toContain('2025-06-06');
  });
});

// ---------------------------------------------------------------------------
// AC6 — overall_status: 'healthy'
// ---------------------------------------------------------------------------

describe("AC6 — overall_status: 'healthy'", () => {
  it("returns 'healthy' when all checks pass", async () => {
    const result = await handler();
    expect(result.overall_status).toBe('healthy');
  });

  it("returns 'healthy' only when SSH connected", async () => {
    const result = await handler();
    expect(result.ssh_connected).toBe(true);
  });

  it("returns 'healthy' only when both HTTP checks are 200", async () => {
    const result = await handler();
    expect(result.http_health.status_code).toBe(200);
    expect(result.http_ready.status_code).toBe(200);
  });

  it("returns 'healthy' only when systemd is active/running with 0 restarts", async () => {
    const result = await handler();
    expect(result.process.active_state).toBe('active');
    expect(result.process.sub_state).toBe('running');
    expect(result.process.restarts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC7 — overall_status: 'degraded'
// ---------------------------------------------------------------------------

describe("AC7 — overall_status: 'degraded'", () => {
  it("returns 'degraded' when /health returns non-200 status", async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(503, { ok: false }))
      .mockResolvedValueOnce(mockResponse(200, { ready: true }));

    const result = await handler();
    expect(result.overall_status).toBe('degraded');
  });

  it("returns 'degraded' when /health/ready returns non-200 status", async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(200, { ok: true }))
      .mockResolvedValueOnce(mockResponse(503, { ready: false }));

    const result = await handler();
    expect(result.overall_status).toBe('degraded');
  });

  it("returns 'degraded' when HTTP body is null (non-JSON response)", async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(200, null)) // non-JSON
      .mockResolvedValueOnce(mockResponse(200, { ready: true }));

    const result = await handler();
    expect(result.overall_status).toBe('degraded');
  });

  it("returns 'degraded' when the process has recent restarts", async () => {
    mockExec.mockResolvedValue({ stdout: RESTARTED_SYSTEMCTL, stderr: '', exitCode: 0 });

    const result = await handler();
    expect(result.overall_status).toBe('degraded');
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringMatching(/restarted/)]));
  });

  it("returns 'degraded' when systemd unit is not running", async () => {
    mockExec.mockResolvedValue({ stdout: STOPPED_SYSTEMCTL, stderr: '', exitCode: 0 });

    const result = await handler();
    expect(result.overall_status).toBe('degraded');
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/not running/)])
    );
  });

  it("returns 'degraded' when systemctl exec throws but HTTP is reachable", async () => {
    mockExec.mockRejectedValue(new Error('SSH exec failed'));

    const result = await handler();
    expect(result.overall_status).toBe('degraded');
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/Process supervisor check failed/)])
    );
  });
});

// ---------------------------------------------------------------------------
// AC8 — overall_status: 'unreachable'
// ---------------------------------------------------------------------------

describe("AC8 — overall_status: 'unreachable'", () => {
  it("returns 'unreachable' when SSH is not connected", async () => {
    jest.useFakeTimers();
    mockIsConnected.mockReturnValue(false);
    mockFetch
      .mockResolvedValueOnce(mockResponse(200, { ok: true }))
      .mockResolvedValueOnce(mockResponse(200, { ready: true }));

    const p = handler();
    await jest.runAllTimersAsync();
    const result = await p;

    expect(result.overall_status).toBe('unreachable');
    jest.useRealTimers();
  });

  it("returns 'unreachable' when HTTP /health is completely unreachable", async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(mockResponse(200, { ready: true }));

    const result = await handler();
    expect(result.overall_status).toBe('unreachable');
  });

  it("returns 'unreachable' when HTTP /health/ready is completely unreachable", async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(200, { ok: true }))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await handler();
    expect(result.overall_status).toBe('unreachable');
  });

  it("adds SSH error to the errors array when unreachable due to SSH", async () => {
    jest.useFakeTimers();
    mockIsConnected.mockReturnValue(false);
    mockFetch
      .mockResolvedValueOnce(mockResponse(200, { ok: true }))
      .mockResolvedValueOnce(mockResponse(200, { ready: true }));

    const p = handler();
    await jest.runAllTimersAsync();
    const result = await p;

    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/SSH not connected/)])
    );
    jest.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// AC9 — output matches the defined JSON schema shape
// ---------------------------------------------------------------------------

describe('AC9 — output schema', () => {
  it('always includes overall_status, ssh_connected, http_health, http_ready, process, errors, checked_at', async () => {
    const result = await handler();
    expect(result).toHaveProperty('overall_status');
    expect(result).toHaveProperty('ssh_connected');
    expect(result).toHaveProperty('http_health');
    expect(result).toHaveProperty('http_ready');
    expect(result).toHaveProperty('process');
    expect(result).toHaveProperty('errors');
    expect(result).toHaveProperty('checked_at');
  });

  it('overall_status is one of the three allowed enum values', async () => {
    const result = await handler();
    expect(['healthy', 'degraded', 'unreachable']).toContain(result.overall_status);
  });

  it('errors is always an array', async () => {
    const result = await handler();
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it('checked_at is a valid ISO 8601 string', async () => {
    const result = await handler();
    expect(() => new Date(result.checked_at)).not.toThrow();
    expect(result.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('http_health contains reachable, status_code, and body', async () => {
    const result = await handler();
    expect(result.http_health).toHaveProperty('reachable');
    expect(result.http_health).toHaveProperty('status_code');
    expect(result.http_health).toHaveProperty('body');
  });

  it('process includes running, active_state, sub_state, started_at, uptime_seconds, restarts', async () => {
    const result = await handler();
    expect(result.process).toMatchObject({
      running:        expect.any(Boolean),
      active_state:   expect.any(String),
      sub_state:      expect.any(String),
      restarts:       expect.any(Number),
    });
  });

  it('process is null when SSH is not connected', async () => {
    jest.useFakeTimers();
    mockIsConnected.mockReturnValue(false);
    mockFetch
      .mockResolvedValueOnce(mockResponse(200, { ok: true }))
      .mockResolvedValueOnce(mockResponse(200, { ready: true }));

    const p = handler();
    await jest.runAllTimersAsync();
    const result = await p;

    expect(result.process).toBeNull();
    jest.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// AC10 — riskLevel and schema exports
// ---------------------------------------------------------------------------

describe('AC10 — module exports', () => {
  const tool = require('../../src/tools/health-check');

  it("exports riskLevel: 'read'", () => {
    expect(tool.riskLevel).toBe('read');
  });

  it("exports name: 'health_check'", () => {
    expect(tool.name).toBe('health_check');
  });

  it('exports a schema with description and inputSchema', () => {
    expect(tool.schema).toHaveProperty('description');
    expect(tool.schema).toHaveProperty('inputSchema');
  });

  it('inputSchema has additionalProperties: false and empty required array', () => {
    expect(tool.schema.inputSchema.additionalProperties).toBe(false);
    expect(tool.schema.inputSchema.required).toEqual([]);
  });

  it('exports handler as a function', () => {
    expect(typeof tool.handler).toBe('function');
  });
});
