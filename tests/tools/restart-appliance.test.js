'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockExec      = jest.fn();
const mockGetConfig = jest.fn();
const mockFetch     = jest.fn();

jest.mock('../../src/ssh-backend',     () => ({ exec: (...a) => mockExec(...a) }));
jest.mock('../../config/cosa.config',  () => ({ getConfig: (...a) => mockGetConfig(...a) }));
global.fetch = mockFetch;

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

const { handler, name, riskLevel, schema } = require('../../src/tools/restart-appliance');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_CONFIG = {
  appliance: {
    process_supervisor: { service_name: 'baanbaan' },
    appliance_api: {
      base_url:             'http://127.0.0.1:3000',
      health_ready_endpoint: '/health/ready',
      request_timeout_ms:    1000,
    },
    tools: {
      restart_appliance: { graceful_timeout_seconds: 2 }, // keep test runtime short
    },
  },
};

const SHOW_OUTPUT = (iso) => ({
  stdout:   `ExecMainStartTimestamp=Mon ${iso}\n`,
  stderr:   '',
  exitCode: 0,
});

const RESTART_OK = { stdout: '', stderr: '', exitCode: 0 };

const HEALTH_OK   = { ok: true,  status: 200, json: async () => ({ ready: true }) };
const HEALTH_DOWN = { ok: false, status: 503, json: async () => ({ ready: false }) };

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockExec.mockReset();
  mockGetConfig.mockReset().mockReturnValue(BASE_CONFIG);
  mockFetch.mockReset();
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

describe('restart_appliance — metadata', () => {
  it('exports name and risk level', () => {
    expect(name).toBe('restart_appliance');
    expect(riskLevel).toBe('high');
  });

  it('takes no input arguments', () => {
    expect(schema.inputSchema.properties).toEqual({});
    expect(schema.inputSchema.additionalProperties).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('restart_appliance — happy path', () => {
  it('issues systemctl restart and reports success when the service comes back healthy', async () => {
    mockExec
      .mockResolvedValueOnce(SHOW_OUTPUT('2026-05-19 04:00:00 UTC')) // uptime fetch
      .mockResolvedValueOnce(RESTART_OK);                              // restart
    mockFetch.mockResolvedValueOnce(HEALTH_OK);

    const result = await handler();

    expect(result.success).toBe(true);
    expect(result.service_name).toBe('baanbaan');
    expect(result.came_up_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.health_after.status_code).toBe(200);
    expect(result.error).toBeUndefined();
  });

  it('captures pre-restart uptime', async () => {
    const startedIso = new Date(Date.now() - 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
    mockExec
      .mockResolvedValueOnce(SHOW_OUTPUT(startedIso))
      .mockResolvedValueOnce(RESTART_OK);
    mockFetch.mockResolvedValueOnce(HEALTH_OK);

    const result = await handler();
    // ~1h ± 5s margin
    expect(result.uptime_before_ms).toBeGreaterThan(60 * 60 * 1000 - 5000);
    expect(result.uptime_before_ms).toBeLessThan(60 * 60 * 1000 + 5000);
  });

  it('issues the systemctl restart command with the configured service name', async () => {
    mockExec
      .mockResolvedValueOnce(SHOW_OUTPUT('2026-05-19 04:00:00 UTC'))
      .mockResolvedValueOnce(RESTART_OK);
    mockFetch.mockResolvedValueOnce(HEALTH_OK);

    await handler();

    expect(mockExec).toHaveBeenNthCalledWith(2, 'systemctl restart baanbaan');
  });
});

// ---------------------------------------------------------------------------
// Service-name safety (AC for review §B P2 #12)
// ---------------------------------------------------------------------------

describe('restart_appliance — service-name safety', () => {
  it('rejects names with shell metacharacters and does not echo the raw value', async () => {
    mockGetConfig.mockReturnValue({
      ...BASE_CONFIG,
      appliance: {
        ...BASE_CONFIG.appliance,
        process_supervisor: { service_name: "bad'; rm -rf /; echo '" },
      },
    });
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }); // uptime fetch tolerates anything

    const result = await handler();

    expect(result.success).toBe(false);
    // After the §B P2 #12 fix, the error message must NOT echo the raw bytes —
    // only the regex and a character count.
    expect(result.error).toMatch(/failed safety check/);
    expect(result.error).not.toContain('rm -rf');
    expect(result.error).not.toContain("'");
    expect(result.error).toMatch(/received \d+ character\(s\)/);
  });

  it('accepts standard systemd-style names (letters, digits, dot, dash, underscore)', async () => {
    mockGetConfig.mockReturnValue({
      ...BASE_CONFIG,
      appliance: {
        ...BASE_CONFIG.appliance,
        process_supervisor: { service_name: 'baanbaan-ocr.service' },
      },
    });
    mockExec
      .mockResolvedValueOnce(SHOW_OUTPUT('2026-05-19 04:00:00 UTC'))
      .mockResolvedValueOnce(RESTART_OK);
    mockFetch.mockResolvedValueOnce(HEALTH_OK);

    const result = await handler();
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Failure paths
// ---------------------------------------------------------------------------

describe('restart_appliance — failure paths', () => {
  it('reports success=false when systemctl restart exits non-zero', async () => {
    mockExec
      .mockResolvedValueOnce(SHOW_OUTPUT('2026-05-19 04:00:00 UTC'))
      .mockResolvedValueOnce({ stdout: '', stderr: 'Unit baanbaan.service not found', exitCode: 5 });

    const result = await handler();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exited with code 5/);
    expect(result.error).toMatch(/Unit baanbaan\.service not found/);
  });

  it('reports success=false when /health/ready never returns 200 within the timeout', async () => {
    mockExec
      .mockResolvedValueOnce(SHOW_OUTPUT('2026-05-19 04:00:00 UTC'))
      .mockResolvedValueOnce(RESTART_OK);
    // All health probes fail.
    mockFetch.mockResolvedValue(HEALTH_DOWN);

    const result = await handler();
    expect(result.success).toBe(false);
    expect(result.came_up_at).toBeNull();
    expect(result.error).toMatch(/did not become healthy/);
  });

  it('still reports the pre-restart uptime even when the restart itself fails', async () => {
    const startedIso = new Date(Date.now() - 5 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
    mockExec
      .mockResolvedValueOnce(SHOW_OUTPUT(startedIso))
      .mockResolvedValueOnce({ stdout: '', stderr: 'oops', exitCode: 1 });

    const result = await handler();
    expect(result.success).toBe(false);
    expect(result.uptime_before_ms).toBeGreaterThan(4 * 60 * 1000);
  });

  it('tolerates an SSH error during uptime fetch (returns uptime_before_ms=null)', async () => {
    mockExec
      .mockRejectedValueOnce(new Error('SSH not connected'))
      .mockResolvedValueOnce(RESTART_OK);
    mockFetch.mockResolvedValueOnce(HEALTH_OK);

    const result = await handler();
    expect(result.success).toBe(true);
    expect(result.uptime_before_ms).toBeNull();
  });

  it('tolerates a malformed ExecMainStartTimestamp (returns uptime_before_ms=null)', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: 'ExecMainStartTimestamp=not-a-date\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce(RESTART_OK);
    mockFetch.mockResolvedValueOnce(HEALTH_OK);

    const result = await handler();
    expect(result.uptime_before_ms).toBeNull();
  });
});
