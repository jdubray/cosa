'use strict';

jest.mock('../config/cosa.config');
jest.mock('../src/appliance-auth');
jest.mock('../src/credential-store');
jest.mock('../src/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }),
}));

const { getConfig }         = require('../config/cosa.config');
const { withApplianceAuth } = require('../src/appliance-auth');
const credentialStore       = require('../src/credential-store');
const { handler }           = require('../src/tools/appliance-api-call');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_URL   = 'http://appliance.local:3000';
const TIMEOUT_MS = 10000;
const MERCHANT   = 'merch_001';

const UPDATE_ORDER_ENDPOINT = {
  name:        'update_order_status',
  path:        '/api/merchants/:merchantId/orders/:orderId/status',
  method:      'PATCH',
  risk:        'medium',
  description: 'Transition an order to a new status',
  path_params: {
    merchantId: '${credential:appliance_merchant_id}',
    orderId:    'caller',
  },
  body_schema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['confirmed', 'preparing', 'ready', 'completed', 'cancelled'] },
      note:   { type: 'string' },
    },
    required: ['status'],
  },
};

const PAUSE_STORE_ENDPOINT = {
  name:        'pause_store',
  path:        '/api/merchants/:merchantId/store/pause',
  method:      'PATCH',
  risk:        'high',
  description: 'Pause or resume online ordering',
  path_params: {
    merchantId: '${credential:appliance_merchant_id}',
  },
  body_schema: {
    type: 'object',
    properties: {
      paused: { type: 'boolean' },
      reason: { type: 'string' },
    },
    required: ['paused', 'reason'],
  },
};

function setConfig(endpoints = [UPDATE_ORDER_ENDPOINT, PAUSE_STORE_ENDPOINT]) {
  getConfig.mockReturnValue({
    appliance: {
      appliance_api: {
        base_url:           BASE_URL,
        request_timeout_ms: TIMEOUT_MS,
        api_endpoints:      endpoints,
      },
    },
  });
}

function setupCredentials() {
  credentialStore.get.mockImplementation(key => {
    if (key === 'appliance_merchant_id') return MERCHANT;
    return 'cred_value';
  });
}

/**
 * Configure withApplianceAuth to invoke apiFn transparently with empty headers,
 * and have global.fetch return the configured HTTP response.
 */
function mockHttpSuccess(status = 200, body = { ok: true }) {
  withApplianceAuth.mockImplementation(async (apiFn) => apiFn({}));
  global.fetch = jest.fn().mockResolvedValue({
    status,
    ok:   status >= 200 && status < 300,
    json: async () => body,
  });
}

function mockHttpError(code = 'APPLIANCE_NETWORK_ERROR', msg = 'timeout') {
  withApplianceAuth.mockRejectedValue(Object.assign(new Error(msg), { code }));
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  setConfig();
  setupCredentials();
});

afterEach(() => {
  delete global.fetch;
});

// ===========================================================================
// AC1 — allowlist enforcement
// ===========================================================================

describe('AC1 — allowlist enforcement', () => {
  test('rejects endpoint not in allowlist', async () => {
    const result = await handler({ endpoint_name: 'cancel_all_orders', body: {} });

    expect(result.success).toBe(false);
    expect(result.code).toBe('APPLIANCE_ENDPOINT_NOT_ALLOWED');
    expect(result.error).toContain('cancel_all_orders');
  });

  test('accepts endpoint that is in allowlist', async () => {
    mockHttpSuccess(200, { orderId: 'ord_abc', status: 'confirmed' });

    const result = await handler({
      endpoint_name: 'update_order_status',
      path_params:   { orderId: 'ord_abc' },
      body:          { status: 'confirmed' },
    });

    expect(result.success).toBe(true);
    expect(result.endpoint_name).toBe('update_order_status');
  });

  test('returns actioned_at on all results', async () => {
    const result = await handler({ endpoint_name: 'no_such', body: {} });
    expect(result.actioned_at).toBeTruthy();
  });
});

// ===========================================================================
// AC2 — successful call result shape
// ===========================================================================

describe('AC2 — successful call result shape', () => {
  test('returns expected fields on 200', async () => {
    const responseBody = { orderId: 'ord_abc', status: 'confirmed', updatedAt: '2026-04-08T12:00:00Z' };
    mockHttpSuccess(200, responseBody);

    const result = await handler({
      endpoint_name: 'update_order_status',
      path_params:   { orderId: 'ord_abc' },
      body:          { status: 'confirmed' },
    });

    expect(result).toMatchObject({
      success:       true,
      endpoint_name: 'update_order_status',
      method:        'PATCH',
      status_code:   200,
      body:          responseBody,
    });
    expect(result.actioned_at).toBeTruthy();
  });
});

// ===========================================================================
// AC3 — path param injection prevention
// ===========================================================================

describe('AC3 — path param injection prevention', () => {
  test('rejects caller-supplied value for static (credential) param', async () => {
    const result = await handler({
      endpoint_name: 'update_order_status',
      path_params:   { merchantId: 'evil_merchant', orderId: 'ord_abc' },
      body:          { status: 'confirmed' },
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('APPLIANCE_PARAM_INJECTION');
    expect(result.error).toContain('merchantId');
  });

  test('accepts caller-supplied value for "caller" param', async () => {
    mockHttpSuccess(200, {});

    const result = await handler({
      endpoint_name: 'update_order_status',
      path_params:   { orderId: 'ord_xyz' },
      body:          { status: 'preparing' },
    });

    expect(result.success).toBe(true);
    const url = global.fetch.mock.calls[0][0];
    expect(url).toContain('ord_xyz');
  });

  test('rejects missing required caller param', async () => {
    const result = await handler({
      endpoint_name: 'update_order_status',
      path_params:   {},   // orderId missing
      body:          { status: 'confirmed' },
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('APPLIANCE_PARAM_MISSING');
  });
});

// ===========================================================================
// AC4 — credential param resolution
// ===========================================================================

describe('AC4 — credential param resolution', () => {
  test('resolves merchantId from credential store', async () => {
    mockHttpSuccess(200, {});

    await handler({
      endpoint_name: 'pause_store',
      body:          { paused: true, reason: 'maintenance' },
      reason:        'scheduled maintenance window',
    });

    const url = global.fetch.mock.calls[0][0];
    expect(url).toContain(MERCHANT);
  });

  test('static credential param is not exposed to caller', async () => {
    mockHttpSuccess(200, {});

    const result = await handler({
      endpoint_name: 'pause_store',
      body:          { paused: true, reason: 'test' },
      reason:        'testing static param enforcement',
    });

    expect(result.success).toBe(true);
  });
});

// ===========================================================================
// AC5 — body schema validation
// ===========================================================================

describe('AC5 — body schema validation', () => {
  test('rejects body with invalid enum value', async () => {
    const result = await handler({
      endpoint_name: 'update_order_status',
      path_params:   { orderId: 'ord_abc' },
      body:          { status: 'refunded' },   // not in enum
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('APPLIANCE_BODY_INVALID');
    expect(result.validation_errors).toBeDefined();
    expect(result.validation_errors.length).toBeGreaterThan(0);
  });

  test('rejects body missing required field', async () => {
    const result = await handler({
      endpoint_name: 'pause_store',
      body:          { paused: true },   // body.reason missing — body_schema requires it
      reason:        'kitchen overwhelmed',
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('APPLIANCE_BODY_INVALID');
  });

  test('accepts valid body', async () => {
    mockHttpSuccess(200, {});

    const result = await handler({
      endpoint_name: 'pause_store',
      body:          { paused: true, reason: 'kitchen overload' },
      reason:        'kitchen overwhelmed — pausing temporarily',
    });

    expect(result.success).toBe(true);
  });

  test('validation_errors are human-readable strings', async () => {
    const result = await handler({
      endpoint_name: 'update_order_status',
      path_params:   { orderId: 'ord_abc' },
      body:          { status: 'bad_value' },
    });

    expect(result.validation_errors.every(e => typeof e === 'string')).toBe(true);
  });
});

// ===========================================================================
// AC6 — appliance non-2xx response
// ===========================================================================

describe('AC6 — appliance non-2xx response', () => {
  test('returns success:false with status_code on 422', async () => {
    mockHttpSuccess(422, { error: 'Invalid transition: completed → confirmed' });

    const result = await handler({
      endpoint_name: 'update_order_status',
      path_params:   { orderId: 'ord_abc' },
      body:          { status: 'confirmed' },
    });

    expect(result.success).toBe(false);
    expect(result.status_code).toBe(422);
    expect(result.error).toContain('422');
    expect(result.body).toMatchObject({ error: expect.stringContaining('Invalid') });
  });

  test('includes endpoint_name and method on non-2xx response', async () => {
    mockHttpSuccess(500, { error: 'server error' });

    const result = await handler({
      endpoint_name: 'update_order_status',
      path_params:   { orderId: 'ord_abc' },
      body:          { status: 'confirmed' },
    });

    expect(result.endpoint_name).toBe('update_order_status');
    expect(result.method).toBe('PATCH');
  });
});

// ===========================================================================
// AC7 — network / auth errors
// ===========================================================================

describe('AC7 — network and auth errors', () => {
  test('returns success:false on network error', async () => {
    mockHttpError('APPLIANCE_NETWORK_ERROR', 'Request timed out after 10000ms');

    const result = await handler({
      endpoint_name: 'update_order_status',
      path_params:   { orderId: 'ord_abc' },
      body:          { status: 'confirmed' },
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('APPLIANCE_NETWORK_ERROR');
    expect(result.endpoint_name).toBe('update_order_status');
  });

  test('returns success:false on auth failure', async () => {
    mockHttpError('APPLIANCE_AUTH_FAILED', 'All authentication attempts failed');

    const result = await handler({
      endpoint_name: 'update_order_status',
      path_params:   { orderId: 'ord_abc' },
      body:          { status: 'confirmed' },
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('APPLIANCE_AUTH_FAILED');
  });
});

// ===========================================================================
// AC8 — correct HTTP method and request format
// ===========================================================================

describe('AC8 — HTTP method from allowlist', () => {
  test('uses PATCH for update_order_status', async () => {
    mockHttpSuccess(200, {});

    await handler({
      endpoint_name: 'update_order_status',
      path_params:   { orderId: 'ord_abc' },
      body:          { status: 'confirmed' },
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: 'PATCH' })
    );
  });

  test('sends body as JSON', async () => {
    mockHttpSuccess(200, {});

    await handler({
      endpoint_name: 'update_order_status',
      path_params:   { orderId: 'ord_abc' },
      body:          { status: 'ready', note: 'order is ready' },
    });

    const fetchOpts  = global.fetch.mock.calls[0][1];
    const parsedBody = JSON.parse(fetchOpts.body);
    expect(parsedBody).toEqual({ status: 'ready', note: 'order is ready' });
  });

  test('includes Content-Type: application/json header', async () => {
    mockHttpSuccess(200, {});

    await handler({
      endpoint_name: 'pause_store',
      body:          { paused: false, reason: 'reopening' },
      reason:        'reopening after maintenance',
    });

    const fetchOpts = global.fetch.mock.calls[0][1];
    expect(fetchOpts.headers['Content-Type']).toBe('application/json');
  });
});

// ===========================================================================
// AC9 — reason enforcement for high-risk endpoints (M2)
// ===========================================================================

describe('AC9 — reason enforcement', () => {
  test('rejects high-risk endpoint with no reason', async () => {
    const result = await handler({
      endpoint_name: 'pause_store',
      body:          { paused: true, reason: 'too busy' },
      // no `reason` field at the tool input level
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('APPLIANCE_REASON_REQUIRED');
    expect(result.error).toContain('pause_store');
  });

  test('rejects high-risk endpoint with whitespace-only reason', async () => {
    const result = await handler({
      endpoint_name: 'pause_store',
      body:          { paused: true, reason: 'too busy' },
      reason:        '   ',
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('APPLIANCE_REASON_REQUIRED');
  });

  test('accepts high-risk endpoint with a non-empty reason', async () => {
    mockHttpSuccess(200, { paused: true });

    const result = await handler({
      endpoint_name: 'pause_store',
      body:          { paused: true, reason: 'too busy' },
      reason:        'kitchen overwhelmed — pausing for 30 minutes',
    });

    expect(result.success).toBe(true);
  });

  test('medium-risk endpoint does not require reason', async () => {
    mockHttpSuccess(200, {});

    const result = await handler({
      endpoint_name: 'update_order_status',
      path_params:   { orderId: 'ord_abc' },
      body:          { status: 'confirmed' },
      // no reason — should succeed
    });

    expect(result.success).toBe(true);
  });
});
