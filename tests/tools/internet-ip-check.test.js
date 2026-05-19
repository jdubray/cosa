'use strict';

const mockFetch = jest.fn();
global.fetch = mockFetch;

const { handler, name, riskLevel, schema } = require('../../src/tools/internet-ip-check');

beforeEach(() => {
  mockFetch.mockReset();
});

describe('internet_ip_check — metadata', () => {
  it('exports the expected name and risk level', () => {
    expect(name).toBe('internet_ip_check');
    expect(riskLevel).toBe('read');
  });

  it('takes no input arguments', () => {
    expect(schema.inputSchema.properties).toEqual({});
    expect(schema.inputSchema.additionalProperties).toBe(false);
  });
});

describe('internet_ip_check — handler', () => {
  it('returns internetUp=true and the IP when the upstream returns 200 + JSON', async () => {
    mockFetch.mockResolvedValue({
      ok:   true,
      json: async () => ({ ip: '203.0.113.42' }),
    });
    const r = await handler();
    expect(r.internetUp).toBe(true);
    expect(r.publicIp).toBe('203.0.113.42');
    expect(r.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('trims whitespace from the upstream-reported IP', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ip: '  203.0.113.42  ' }) });
    const r = await handler();
    expect(r.publicIp).toBe('203.0.113.42');
  });

  it('returns internetUp=false on a non-2xx response', async () => {
    mockFetch.mockResolvedValue({ ok: false, json: async () => ({}) });
    const r = await handler();
    expect(r.internetUp).toBe(false);
    expect(r.publicIp).toBe(null);
  });

  it('returns internetUp=false when fetch rejects (timeout / network error)', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));
    const r = await handler();
    expect(r.internetUp).toBe(false);
    expect(r.publicIp).toBe(null);
  });

  it('returns internetUp=false when the JSON body lacks an ip field', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    const r = await handler();
    expect(r.internetUp).toBe(false);
    expect(r.publicIp).toBe(null);
  });

  it('returns internetUp=false when ip is non-string (defensive)', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ip: 12345 }) });
    const r = await handler();
    expect(r.internetUp).toBe(false);
    expect(r.publicIp).toBe(null);
  });

  it('passes an AbortSignal to fetch (so the 10s timeout can fire)', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ip: '1.2.3.4' }) });
    await handler();
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.signal).toBeDefined();
    // The AbortController.signal is duck-typeable by aborted/onabort.
    expect(typeof opts.signal.aborted).toBe('boolean');
  });

  it('returns checkedAt regardless of outcome', async () => {
    mockFetch.mockRejectedValue(new Error('x'));
    const r = await handler();
    expect(r.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
