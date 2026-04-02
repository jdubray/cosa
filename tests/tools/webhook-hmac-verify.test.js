'use strict';

jest.mock('../../config/cosa.config');
jest.mock('../../src/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }),
}));

const { getConfig } = require('../../config/cosa.config');
const { handler, name, riskLevel } = require('../../src/tools/webhook-hmac-verify');

const DEFAULT_CONFIG = {
  appliance: {
    appliance_api: {
      base_url:           'http://192.168.1.100:3000',
      request_timeout_ms: 5000,
    },
  },
};

/** Spy on global.fetch and make it return a controlled response. */
let mockFetch;

beforeEach(() => {
  getConfig.mockReturnValue(DEFAULT_CONFIG);
  mockFetch = jest.spyOn(global, 'fetch');
});

afterEach(() => {
  mockFetch.mockRestore();
});

/** Build a minimal Response-like object that fetch would return. */
function fakeResponse(status) {
  return Promise.resolve({ status });
}

/** Make fetch throw (simulate network error / timeout via AbortError). */
function fakeNetworkError(message = 'network failure') {
  return Promise.reject(new Error(message));
}

function fakeAbortError() {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return Promise.reject(err);
}

// ---------------------------------------------------------------------------
// AC1: Sends POST to the correct endpoint with invalid X-Signature
// ---------------------------------------------------------------------------

describe('AC1 – sends POST with invalid X-Signature', () => {
  test('calls fetch with POST method', async () => {
    mockFetch.mockReturnValue(fakeResponse(401));
    await handler();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, options] = mockFetch.mock.calls[0];
    expect(options.method).toBe('POST');
  });

  test('sends request to /api/webhooks/pos/test-merchant by default', async () => {
    mockFetch.mockReturnValue(fakeResponse(401));
    await handler();
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://192.168.1.100:3000/api/webhooks/pos/test-merchant');
  });

  test('includes X-Signature header with deliberately invalid value', async () => {
    mockFetch.mockReturnValue(fakeResponse(401));
    await handler();
    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers['X-Signature']).toBeDefined();
    expect(options.headers['X-Signature']).toMatch(/cosa-probe-invalid|00000000/);
  });

  test('sends Content-Type: application/json', async () => {
    mockFetch.mockReturnValue(fakeResponse(401));
    await handler();
    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers['Content-Type']).toBe('application/json');
  });

  test('uses custom endpoint from config when provided', async () => {
    getConfig.mockReturnValue({
      appliance: {
        appliance_api: { base_url: 'http://192.168.1.100:3000', request_timeout_ms: 5000 },
        tools: { webhook_hmac_verify: { endpoint: '/api/webhooks/pos/custom-merchant' } },
      },
    });
    mockFetch.mockReturnValue(fakeResponse(401));
    await handler();
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/webhooks/pos/custom-merchant');
  });

  test('endpoint field in result matches URL used', async () => {
    mockFetch.mockReturnValue(fakeResponse(401));
    const result = await handler();
    expect(result.endpoint).toBe('http://192.168.1.100:3000/api/webhooks/pos/test-merchant');
  });
});

// ---------------------------------------------------------------------------
// AC2: Returns verified: true on HTTP 401
// ---------------------------------------------------------------------------

describe('AC2 – verified: true when response is HTTP 401', () => {
  test('verified is true', async () => {
    mockFetch.mockReturnValue(fakeResponse(401));
    const result = await handler();
    expect(result.verified).toBe(true);
  });

  test('status_code is 401', async () => {
    mockFetch.mockReturnValue(fakeResponse(401));
    const result = await handler();
    expect(result.status_code).toBe(401);
  });

  test('severity is null (not a problem)', async () => {
    mockFetch.mockReturnValue(fakeResponse(401));
    const result = await handler();
    expect(result.severity).toBeNull();
  });

  test('message confirms HMAC is active', async () => {
    mockFetch.mockReturnValue(fakeResponse(401));
    const result = await handler();
    expect(result.message).toMatch(/HMAC|signature.*active|401/i);
  });
});

// ---------------------------------------------------------------------------
// AC3: Returns verified: false with severity 'critical' on HTTP 200
// ---------------------------------------------------------------------------

describe("AC3 – verified: false with severity 'critical' when response is HTTP 200", () => {
  test('verified is false', async () => {
    mockFetch.mockReturnValue(fakeResponse(200));
    const result = await handler();
    expect(result.verified).toBe(false);
  });

  test("severity is 'critical'", async () => {
    mockFetch.mockReturnValue(fakeResponse(200));
    const result = await handler();
    expect(result.severity).toBe('critical');
  });

  test('status_code is 200', async () => {
    mockFetch.mockReturnValue(fakeResponse(200));
    const result = await handler();
    expect(result.status_code).toBe(200);
  });

  test('message clearly describes the HMAC bypass', async () => {
    mockFetch.mockReturnValue(fakeResponse(200));
    const result = await handler();
    expect(result.message).toMatch(/HMAC.*not enforced|spoofing|CRITICAL/i);
  });
});

// ---------------------------------------------------------------------------
// AC4: HTTP request to Baanbaan on local network (fetch, not SSH)
// ---------------------------------------------------------------------------

describe('AC4 – HTTP request made directly via fetch (not SSH)', () => {
  test('fetch is called (not sshBackend)', async () => {
    mockFetch.mockReturnValue(fakeResponse(401));
    await handler();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('URL uses base_url from appliance_api config', async () => {
    getConfig.mockReturnValue({
      appliance: {
        appliance_api: { base_url: 'http://10.0.0.5:3000', request_timeout_ms: 5000 },
      },
    });
    mockFetch.mockReturnValue(fakeResponse(401));
    await handler();
    const [url] = mockFetch.mock.calls[0];
    expect(url).toMatch(/^http:\/\/10\.0\.0\.5:3000\//);
  });

  test('result includes endpoint field with full URL', async () => {
    mockFetch.mockReturnValue(fakeResponse(401));
    const result = await handler();
    expect(result.endpoint).toMatch(/^http:\/\//);
    expect(result.endpoint).toContain('/api/webhooks/pos/');
  });

  test('request uses an AbortController signal for timeout', async () => {
    mockFetch.mockReturnValue(fakeResponse(401));
    await handler();
    const [, options] = mockFetch.mock.calls[0];
    expect(options.signal).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AC5: Risk level is 'read'
// ---------------------------------------------------------------------------

describe('AC5 – risk level', () => {
  test("riskLevel is 'read'", () => {
    expect(riskLevel).toBe('read');
  });

  test("name is 'webhook_hmac_verify'", () => {
    expect(name).toBe('webhook_hmac_verify');
  });
});

// ---------------------------------------------------------------------------
// Edge: inconclusive status codes
// ---------------------------------------------------------------------------

describe('inconclusive HTTP status codes', () => {
  test.each([403, 404, 500, 503])(
    'HTTP %d returns verified: false with severity: null',
    async (statusCode) => {
      mockFetch.mockReturnValue(fakeResponse(statusCode));
      const result = await handler();
      expect(result.verified).toBe(false);
      expect(result.severity).toBeNull();
      expect(result.status_code).toBe(statusCode);
    }
  );

  test('message mentions the unexpected status code', async () => {
    mockFetch.mockReturnValue(fakeResponse(503));
    const result = await handler();
    expect(result.message).toContain('503');
  });
});

// ---------------------------------------------------------------------------
// Edge: endpoint unreachable (network error)
// ---------------------------------------------------------------------------

describe('endpoint unreachable', () => {
  test('verified is false when fetch throws a network error', async () => {
    mockFetch.mockImplementation(() => fakeNetworkError('connect ECONNREFUSED'));
    const result = await handler();
    expect(result.verified).toBe(false);
  });

  test('status_code is null when unreachable', async () => {
    mockFetch.mockImplementation(() => fakeNetworkError('connect ECONNREFUSED'));
    const result = await handler();
    expect(result.status_code).toBeNull();
  });

  test('severity is null when unreachable (not a HMAC failure)', async () => {
    mockFetch.mockImplementation(() => fakeNetworkError('connect ECONNREFUSED'));
    const result = await handler();
    expect(result.severity).toBeNull();
  });

  test('message mentions the error detail', async () => {
    mockFetch.mockImplementation(() => fakeNetworkError('connect ECONNREFUSED'));
    const result = await handler();
    expect(result.message).toMatch(/unreachable|ECONNREFUSED/i);
  });

  test('timeout (AbortError) returns verified: false, status_code: null', async () => {
    mockFetch.mockImplementation(() => fakeAbortError());
    const result = await handler();
    expect(result.verified).toBe(false);
    expect(result.status_code).toBeNull();
    expect(result.message).toMatch(/timed out|timeout/i);
  });
});

// ---------------------------------------------------------------------------
// Edge: response shape always includes required fields
// ---------------------------------------------------------------------------

describe('response shape', () => {
  test.each([
    ['401 (pass)', 401],
    ['200 (critical fail)', 200],
    ['503 (inconclusive)', 503],
  ])('%s always returns verified, status_code, severity, endpoint, message, checked_at', async (_, statusCode) => {
    mockFetch.mockReturnValue(fakeResponse(statusCode));
    const result = await handler();
    expect(typeof result.verified).toBe('boolean');
    expect(result.status_code).toBe(statusCode);
    expect('severity' in result).toBe(true);
    expect(typeof result.endpoint).toBe('string');
    expect(typeof result.message).toBe('string');
    expect(typeof result.checked_at).toBe('string');
    expect(() => new Date(result.checked_at)).not.toThrow();
  });
});
