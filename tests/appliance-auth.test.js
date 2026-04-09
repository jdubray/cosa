'use strict';

jest.mock('../config/cosa.config');
jest.mock('../src/credential-store');
jest.mock('../src/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }),
}));

const { getConfig }   = require('../config/cosa.config');
const credentialStore = require('../src/credential-store');
const {
  withApplianceAuth,
  interpolateCredentials,
} = require('../src/appliance-auth');

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

const BASE_URL   = 'http://appliance.local:3000';
const TIMEOUT_MS = 5000;

function makeJwtConfig() {
  return {
    base_url:           BASE_URL,
    request_timeout_ms: TIMEOUT_MS,
    auth: {
      type:                         'jwt',
      login_endpoint:               '/api/auth/login',
      login_body_template:          '{"email":"${credential:appliance_email}","password":"${credential:appliance_password}"}',
      refresh_endpoint:             '/api/auth/refresh',
      refresh_body_template:        '{"refreshToken":"${credential:appliance_refresh_token}"}',
      access_token_credential_key:  'appliance_access_token',
      refresh_token_credential_key: 'appliance_refresh_token',
    },
  };
}

function makeApiKeyConfig() {
  return {
    base_url:           BASE_URL,
    request_timeout_ms: TIMEOUT_MS,
    auth: {
      type:                   'api_key',
      api_key_credential_key: 'appliance_api_key',
      api_key_header:         'X-API-Key',
    },
  };
}

function setConfig(apiCfg) {
  getConfig.mockReturnValue({ appliance: { appliance_api: apiCfg } });
}

// ---------------------------------------------------------------------------
// Credential store helpers
// ---------------------------------------------------------------------------

const CREDS = {
  appliance_access_token:  'tok_access',
  appliance_refresh_token: 'tok_refresh',
  appliance_email:         'user@example.com',
  appliance_password:      'secret',
  appliance_api_key:       'key_abc123',
};

function setupCredStore() {
  credentialStore.get.mockImplementation(key => CREDS[key] ?? '');
  credentialStore.set.mockImplementation((key, val) => { CREDS[key] = val; });
}

// ---------------------------------------------------------------------------
// fetch mock helper
// ---------------------------------------------------------------------------

function mockFetch(responses) {
  let idx = 0;
  global.fetch = jest.fn(async () => {
    const resp = responses[idx++] ?? responses[responses.length - 1];
    if (resp instanceof Error) throw resp;
    return {
      status: resp.status,
      ok:     resp.status >= 200 && resp.status < 300,
      json:   async () => resp.body ?? {},
    };
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  // Reset CREDS to initial values
  Object.assign(CREDS, {
    appliance_access_token:  'tok_access',
    appliance_refresh_token: 'tok_refresh',
    appliance_email:         'user@example.com',
    appliance_password:      'secret',
    appliance_api_key:       'key_abc123',
  });
  setupCredStore();
});

afterEach(() => {
  delete global.fetch;
});

// ===========================================================================
// interpolateCredentials
// ===========================================================================

describe('interpolateCredentials', () => {
  test('replaces ${credential:KEY} placeholders', () => {
    const result = interpolateCredentials(
      '{"email":"${credential:appliance_email}","password":"${credential:appliance_password}"}'
    );
    expect(result).toBe('{"email":"user@example.com","password":"secret"}');
  });

  test('leaves non-credential text intact', () => {
    expect(interpolateCredentials('hello world')).toBe('hello world');
  });

  test('throws CREDENTIAL_NOT_FOUND when credential is missing (null)', () => {
    credentialStore.get.mockReturnValue(null);
    expect(() =>
      interpolateCredentials('{"token":"${credential:missing_key}"}')
    ).toThrow(expect.objectContaining({ code: 'CREDENTIAL_NOT_FOUND' }));
  });

  test('throws CREDENTIAL_NOT_FOUND when credential is empty string', () => {
    credentialStore.get.mockReturnValue('');
    expect(() =>
      interpolateCredentials('{"token":"${credential:empty_key}"}')
    ).toThrow(expect.objectContaining({ code: 'CREDENTIAL_NOT_FOUND' }));
  });

  test('error message includes the missing key name', () => {
    credentialStore.get.mockReturnValue(null);
    expect(() =>
      interpolateCredentials('${credential:appliance_refresh_token}')
    ).toThrow(/appliance_refresh_token/);
  });
});

// ===========================================================================
// auth type: none
// ===========================================================================

describe('withApplianceAuth — type: none', () => {
  test('calls apiFn with empty headers and returns result', async () => {
    setConfig({ base_url: BASE_URL, auth: { type: 'none' } });
    const apiFn = jest.fn().mockResolvedValue({ status: 200, body: { ok: true } });

    const result = await withApplianceAuth(apiFn);

    expect(apiFn).toHaveBeenCalledWith({});
    expect(result).toEqual({ status: 200, body: { ok: true } });
  });

  test('wraps network errors as APPLIANCE_NETWORK_ERROR', async () => {
    setConfig({ base_url: BASE_URL, auth: { type: 'none' } });
    const apiFn = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(withApplianceAuth(apiFn)).rejects.toMatchObject({
      code: 'APPLIANCE_NETWORK_ERROR',
    });
  });
});

// ===========================================================================
// auth type: api_key
// ===========================================================================

describe('withApplianceAuth — type: api_key', () => {
  test('injects X-API-Key header', async () => {
    setConfig(makeApiKeyConfig());
    const apiFn = jest.fn().mockResolvedValue({ status: 200, body: {} });

    await withApplianceAuth(apiFn);

    expect(apiFn).toHaveBeenCalledWith({ 'X-API-Key': 'key_abc123' });
  });

  test('uses configured header name', async () => {
    setConfig({
      base_url: BASE_URL,
      auth: { type: 'api_key', api_key_credential_key: 'appliance_api_key', api_key_header: 'Authorization' },
    });
    const apiFn = jest.fn().mockResolvedValue({ status: 200, body: {} });
    await withApplianceAuth(apiFn);
    expect(apiFn).toHaveBeenCalledWith({ Authorization: 'key_abc123' });
  });

  test('throws APPLIANCE_AUTH_FAILED on 401 (cannot refresh)', async () => {
    setConfig(makeApiKeyConfig());
    const apiFn = jest.fn().mockResolvedValue({ status: 401, body: {} });

    await expect(withApplianceAuth(apiFn)).rejects.toMatchObject({
      code: 'APPLIANCE_AUTH_FAILED',
    });
  });

  test('throws CREDENTIAL_NOT_FOUND when api key credential is null', async () => {
    setConfig(makeApiKeyConfig());
    credentialStore.get.mockImplementation(key =>
      key === 'appliance_api_key' ? null : (CREDS[key] ?? '')
    );

    await expect(withApplianceAuth(jest.fn())).rejects.toMatchObject({
      code: 'CREDENTIAL_NOT_FOUND',
    });
  });

  test('throws CREDENTIAL_NOT_FOUND when api key credential is empty string', async () => {
    setConfig(makeApiKeyConfig());
    credentialStore.get.mockImplementation(key =>
      key === 'appliance_api_key' ? '' : (CREDS[key] ?? '')
    );

    await expect(withApplianceAuth(jest.fn())).rejects.toMatchObject({
      code: 'CREDENTIAL_NOT_FOUND',
    });
  });
});

// ===========================================================================
// auth type: jwt — happy path
// ===========================================================================

describe('withApplianceAuth — jwt happy path', () => {
  test('returns result directly when first call succeeds', async () => {
    setConfig(makeJwtConfig());
    const apiFn = jest.fn().mockResolvedValue({ status: 200, body: { data: 1 } });

    const result = await withApplianceAuth(apiFn);

    expect(apiFn).toHaveBeenCalledTimes(1);
    expect(apiFn).toHaveBeenCalledWith({ Authorization: 'Bearer tok_access' });
    expect(result).toEqual({ status: 200, body: { data: 1 } });
  });

  test('passes through non-401 error codes unchanged', async () => {
    setConfig(makeJwtConfig());
    const apiFn = jest.fn().mockResolvedValue({ status: 403, body: { error: 'forbidden' } });

    const result = await withApplianceAuth(apiFn);
    expect(result.status).toBe(403);
    expect(apiFn).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// auth type: jwt — 401 → refresh → retry
// ===========================================================================

describe('withApplianceAuth — jwt 401 → refresh → retry', () => {
  test('refreshes token on 401 and retries successfully', async () => {
    setConfig(makeJwtConfig());

    // fetch: refresh endpoint returns new token
    mockFetch([{ status: 200, body: { accessToken: 'tok_new', refreshToken: 'tok_ref2' } }]);

    // apiFn: first call 401, second call 200
    const apiFn = jest.fn()
      .mockResolvedValueOnce({ status: 401, body: {} })
      .mockResolvedValueOnce({ status: 200, body: { updated: true } });

    const result = await withApplianceAuth(apiFn);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/auth/refresh'),
      expect.objectContaining({ method: 'POST' })
    );
    expect(credentialStore.set).toHaveBeenCalledWith('appliance_access_token', 'tok_new');
    expect(apiFn).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ status: 200, body: { updated: true } });
  });

  test('stores new refresh token when server rotates it', async () => {
    setConfig(makeJwtConfig());
    mockFetch([{ status: 200, body: { accessToken: 'tok_new2', refreshToken: 'tok_ref_rotated' } }]);

    const apiFn = jest.fn()
      .mockResolvedValueOnce({ status: 401, body: {} })
      .mockResolvedValueOnce({ status: 200, body: {} });

    await withApplianceAuth(apiFn);

    expect(credentialStore.set).toHaveBeenCalledWith('appliance_refresh_token', 'tok_ref_rotated');
  });
});

// ===========================================================================
// auth type: jwt — refresh rejected → re-login → retry
// ===========================================================================

describe('withApplianceAuth — jwt refresh rejected → re-login', () => {
  test('falls back to login when refresh returns 401', async () => {
    setConfig(makeJwtConfig());

    // fetch call 1: refresh → 401; fetch call 2: login → 200
    mockFetch([
      { status: 401, body: {} },
      { status: 200, body: { accessToken: 'tok_fresh', refreshToken: 'tok_ref_fresh' } },
    ]);

    const apiFn = jest.fn()
      .mockResolvedValueOnce({ status: 401, body: {} })
      .mockResolvedValueOnce({ status: 200, body: { logged_in: true } });

    const result = await withApplianceAuth(apiFn);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenNthCalledWith(2,
      expect.stringContaining('/api/auth/login'),
      expect.objectContaining({ method: 'POST' })
    );
    expect(credentialStore.set).toHaveBeenCalledWith('appliance_access_token', 'tok_fresh');
    expect(result).toEqual({ status: 200, body: { logged_in: true } });
  });

  test('throws APPLIANCE_AUTH_FAILED when login also fails', async () => {
    setConfig(makeJwtConfig());

    // Both refresh and login fail
    mockFetch([
      { status: 401, body: {} }, // refresh → 401
      { status: 401, body: {} }, // login → 401
    ]);

    const apiFn = jest.fn().mockResolvedValue({ status: 401, body: {} });

    await expect(withApplianceAuth(apiFn)).rejects.toMatchObject({
      code: 'APPLIANCE_AUTH_FAILED',
    });
  });
});

// ===========================================================================
// network errors
// ===========================================================================

describe('withApplianceAuth — network errors', () => {
  test('wraps fetch AbortError as APPLIANCE_NETWORK_ERROR', async () => {
    setConfig(makeJwtConfig());
    const abortErr = new Error('The operation was aborted');
    abortErr.name  = 'AbortError';
    const apiFn    = jest.fn().mockRejectedValue(abortErr);

    await expect(withApplianceAuth(apiFn)).rejects.toMatchObject({
      code: 'APPLIANCE_NETWORK_ERROR',
    });
  });

  test('wraps arbitrary network error as APPLIANCE_NETWORK_ERROR', async () => {
    setConfig(makeJwtConfig());
    const apiFn = jest.fn().mockRejectedValue(new Error('ENOTFOUND'));

    await expect(withApplianceAuth(apiFn)).rejects.toMatchObject({
      code: 'APPLIANCE_NETWORK_ERROR',
    });
  });

  test('network error on retry after refresh is wrapped correctly', async () => {
    setConfig(makeJwtConfig());
    mockFetch([{ status: 200, body: { accessToken: 'tok_new' } }]);

    const apiFn = jest.fn()
      .mockResolvedValueOnce({ status: 401, body: {} })
      .mockRejectedValueOnce(new Error('socket hang up'));

    await expect(withApplianceAuth(apiFn)).rejects.toMatchObject({
      code: 'APPLIANCE_NETWORK_ERROR',
    });
  });
});

// ===========================================================================
// missing auth config
// ===========================================================================

describe('withApplianceAuth — missing config', () => {
  test('uses empty headers when appliance_api is absent', async () => {
    getConfig.mockReturnValue({ appliance: {} });
    const apiFn = jest.fn().mockResolvedValue({ status: 200, body: {} });

    await withApplianceAuth(apiFn);

    expect(apiFn).toHaveBeenCalledWith({});
  });

  test('uses empty headers when auth type is absent', async () => {
    getConfig.mockReturnValue({ appliance: { appliance_api: { base_url: BASE_URL } } });
    const apiFn = jest.fn().mockResolvedValue({ status: 200, body: {} });

    await withApplianceAuth(apiFn);

    expect(apiFn).toHaveBeenCalledWith({});
  });
});

// ===========================================================================
// empty / missing token field in auth response
// ===========================================================================

describe('withApplianceAuth — unknown token field in response', () => {
  test('throws APPLIANCE_AUTH_FAILED when refresh response has no known token field', async () => {
    setConfig(makeJwtConfig());

    // Refresh succeeds HTTP-wise but response body has an unexpected field name
    mockFetch([{ status: 200, body: { bearer: 'tok_new' } }]);

    const apiFn = jest.fn().mockResolvedValue({ status: 401, body: {} });

    await expect(withApplianceAuth(apiFn)).rejects.toMatchObject({
      code: 'APPLIANCE_AUTH_FAILED',
    });
  });

  test('throws APPLIANCE_AUTH_FAILED when login response has no known token field', async () => {
    setConfig(makeJwtConfig());

    // Refresh fails → login → login response has an unexpected field name
    mockFetch([
      { status: 401, body: {} },              // refresh fails
      { status: 200, body: { jwt: 'tok' } },  // login succeeds but unknown field
    ]);

    const apiFn = jest.fn().mockResolvedValue({ status: 401, body: {} });

    await expect(withApplianceAuth(apiFn)).rejects.toMatchObject({
      code: 'APPLIANCE_AUTH_FAILED',
    });
  });
});

// ===========================================================================
// refresh deduplication
// ===========================================================================

describe('withApplianceAuth — refresh deduplication', () => {
  test('concurrent 401s share one refresh call, not two', async () => {
    setConfig(makeJwtConfig());

    // fetch will be called for the shared refresh only
    mockFetch([{ status: 200, body: { accessToken: 'tok_dedup' } }]);

    const apiFn = jest.fn()
      .mockResolvedValue({ status: 401, body: {} })  // all calls return 401 initially
      .mockResolvedValueOnce({ status: 401 })         // call 1 first attempt
      .mockResolvedValueOnce({ status: 401 })         // call 2 first attempt
      .mockResolvedValue({ status: 200, body: { ok: true } }); // retries succeed

    // Fire two concurrent calls that both hit 401
    const [r1, r2] = await Promise.all([
      withApplianceAuth(apiFn),
      withApplianceAuth(apiFn),
    ]);

    // Only one HTTP refresh call should have been made
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });
});
