'use strict';

jest.mock('../../config/cosa.config');
jest.mock('../../src/ssh-backend');
jest.mock('../../src/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }),
}));

const { getConfig } = require('../../config/cosa.config');
const sshBackend    = require('../../src/ssh-backend');
const { handler, name, riskLevel } = require('../../src/tools/webhook-hmac-verify');

const PROBE_MERCHANT_ID = 'm_test_with_secret';

const DEFAULT_CONFIG = {
  appliance: {
    appliance_api: { base_url: 'http://192.168.1.248:3000', request_timeout_ms: 5000 },
    tools: {
      webhook_hmac_verify: {
        // Fix merchant_id so tests don't have to mock the lookup query.
        merchant_id: PROBE_MERCHANT_ID,
      },
    },
  },
};

beforeEach(() => {
  getConfig.mockReturnValue(DEFAULT_CONFIG);
  sshBackend.exec = jest.fn();
});

// Helper: returns a curl-stdout payload for a given HTTP status.
function curlOutput(httpCode, curlExit = 0) {
  return `HTTP_CODE=${httpCode}\nCURL_EXIT=${curlExit}\n`;
}

function mockSshOk(stdout) {
  sshBackend.exec.mockResolvedValueOnce({ stdout, stderr: '', exitCode: 0 });
}

function mockSshFail(stderr = 'oops', exitCode = 1) {
  sshBackend.exec.mockResolvedValueOnce({ stdout: '', stderr, exitCode });
}

function mockSshThrow(message = 'connection lost') {
  sshBackend.exec.mockRejectedValueOnce(new Error(message));
}

// ---------------------------------------------------------------------------
// AC1 — probe is executed via SSH against the loopback endpoint
// ---------------------------------------------------------------------------

describe('AC1 — probe via SSH against loopback', () => {
  test('invokes sshBackend.exec exactly once', async () => {
    mockSshOk(curlOutput(401));
    await handler();
    expect(sshBackend.exec).toHaveBeenCalledTimes(1);
  });

  test('script targets 127.0.0.1:3000 with the real route shape', async () => {
    mockSshOk(curlOutput(401));
    await handler();
    const [, script] = sshBackend.exec.mock.calls[0];
    expect(script).toContain('http://127.0.0.1:3000/webhooks/generic/' + PROBE_MERCHANT_ID);
  });

  test('uses X-Webhook-Signature header with a deliberately invalid value', async () => {
    mockSshOk(curlOutput(401));
    await handler();
    const [, script] = sshBackend.exec.mock.calls[0];
    expect(script).toMatch(/X-Webhook-Signature:.*sha256=.*cosa-probe-invalid/);
  });

  test('honours custom internal_base_url and path_template from config', async () => {
    getConfig.mockReturnValueOnce({
      appliance: {
        appliance_api: { base_url: 'http://192.168.1.248:3000', request_timeout_ms: 5000 },
        tools: {
          webhook_hmac_verify: {
            merchant_id:       PROBE_MERCHANT_ID,
            internal_base_url: 'http://127.0.0.1:9999',
            path_template:     '/custom/{merchantId}/hook',
          },
        },
      },
    });
    mockSshOk(curlOutput(401));
    const result = await handler();
    expect(result.endpoint).toBe(`http://127.0.0.1:9999/custom/${PROBE_MERCHANT_ID}/hook`);
  });
});

// ---------------------------------------------------------------------------
// AC2 — verified: true on HTTP 401
// ---------------------------------------------------------------------------

describe('AC2 — verified: true when curl reports HTTP 401', () => {
  test('verified is true', async () => {
    mockSshOk(curlOutput(401));
    const result = await handler();
    expect(result.verified).toBe(true);
  });

  test('status_code is 401', async () => {
    mockSshOk(curlOutput(401));
    const result = await handler();
    expect(result.status_code).toBe(401);
  });

  test('severity is null', async () => {
    mockSshOk(curlOutput(401));
    const result = await handler();
    expect(result.severity).toBeNull();
  });

  test('message confirms HMAC enforcement', async () => {
    mockSshOk(curlOutput(401));
    const result = await handler();
    expect(result.message).toMatch(/HMAC|active|401/i);
  });
});

// ---------------------------------------------------------------------------
// AC3 — HTTP 200 is the critical failure case
// ---------------------------------------------------------------------------

describe("AC3 — verified: false with severity 'critical' on HTTP 200", () => {
  test('verified is false', async () => {
    mockSshOk(curlOutput(200));
    const result = await handler();
    expect(result.verified).toBe(false);
  });

  test("severity is 'critical'", async () => {
    mockSshOk(curlOutput(200));
    const result = await handler();
    expect(result.severity).toBe('critical');
  });

  test('status_code is 200', async () => {
    mockSshOk(curlOutput(200));
    const result = await handler();
    expect(result.status_code).toBe(200);
  });

  test('message clearly describes the HMAC bypass', async () => {
    mockSshOk(curlOutput(200));
    const result = await handler();
    expect(result.message).toMatch(/HMAC.*not enforced|spoofing|CRITICAL/i);
  });
});

// ---------------------------------------------------------------------------
// AC4 — risk level / identity
// ---------------------------------------------------------------------------

describe('AC4 — tool identity', () => {
  test("riskLevel is 'read'", () => {
    expect(riskLevel).toBe('read');
  });

  test("name is 'webhook_hmac_verify'", () => {
    expect(name).toBe('webhook_hmac_verify');
  });
});

// ---------------------------------------------------------------------------
// Edge — inconclusive HTTP codes
// ---------------------------------------------------------------------------

describe('inconclusive HTTP status codes', () => {
  test.each([403, 404, 500, 503])(
    'HTTP %d returns verified: false with severity: null',
    async (code) => {
      mockSshOk(curlOutput(code));
      const result = await handler();
      expect(result.verified).toBe(false);
      expect(result.severity).toBeNull();
      expect(result.status_code).toBe(code);
    },
  );

  test('message mentions the unexpected status code', async () => {
    mockSshOk(curlOutput(503));
    const result = await handler();
    expect(result.message).toContain('503');
  });
});

// ---------------------------------------------------------------------------
// Edge — endpoint unreachable from loopback (curl error)
// ---------------------------------------------------------------------------

describe('loopback unreachable', () => {
  test('curl_exit != 0 reports unreachable', async () => {
    mockSshOk(curlOutput(0, 7)); // 7 = CURLE_COULDNT_CONNECT
    const result = await handler();
    expect(result.verified).toBe(false);
    expect(result.severity).toBeNull();
    expect(result.message).toMatch(/unreachable|loopback/i);
  });

  test('SSH connection failure surfaces as unreachable (no throw)', async () => {
    mockSshThrow('connection refused');
    const result = await handler();
    expect(result.verified).toBe(false);
    expect(result.severity).toBeNull();
    expect(result.message).toMatch(/SSH probe failed/i);
  });

  test('SSH script non-zero exit code returns inconclusive (no throw)', async () => {
    mockSshFail('command not found', 127);
    const result = await handler();
    expect(result.verified).toBe(false);
    expect(result.severity).toBeNull();
    expect(result.message).toMatch(/exited 127/);
  });
});

// ---------------------------------------------------------------------------
// Edge — no merchant available for the probe
// ---------------------------------------------------------------------------

describe('merchant resolution', () => {
  test('falls back to runtime DB lookup when merchant_id not configured', async () => {
    getConfig.mockReturnValueOnce({
      appliance: {
        appliance_api: { base_url: 'http://192.168.1.248:3000', request_timeout_ms: 5000 },
        tools: { webhook_hmac_verify: {} },
      },
    });
    // First exec call resolves merchant id; second performs the probe.
    sshBackend.exec
      .mockResolvedValueOnce({ stdout: 'm_runtime_lookup\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: curlOutput(401), stderr: '', exitCode: 0 });

    const result = await handler();
    expect(result.verified).toBe(true);
    expect(result.endpoint).toContain('m_runtime_lookup');
  });

  test('returns inconclusive (not throw) when no merchant can be resolved', async () => {
    getConfig.mockReturnValueOnce({
      appliance: {
        appliance_api: { base_url: 'http://192.168.1.248:3000', request_timeout_ms: 5000 },
        tools: { webhook_hmac_verify: {} },
      },
    });
    sshBackend.exec.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
    const result = await handler();
    expect(result.verified).toBe(false);
    expect(result.severity).toBeNull();
    expect(result.status_code).toBeNull();
    expect(result.message).toMatch(/Could not resolve a merchant/);
  });
});

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

describe('response shape', () => {
  test.each([
    ['401 (pass)', 401],
    ['200 (critical fail)', 200],
    ['503 (inconclusive)', 503],
  ])('%s always returns verified, status_code, severity, endpoint, message, checked_at', async (_, code) => {
    mockSshOk(curlOutput(code));
    const result = await handler();
    expect(typeof result.verified).toBe('boolean');
    expect(result.status_code).toBe(code);
    expect('severity' in result).toBe(true);
    expect(typeof result.endpoint).toBe('string');
    expect(typeof result.message).toBe('string');
    expect(typeof result.checked_at).toBe('string');
    expect(() => new Date(result.checked_at)).not.toThrow();
  });
});
