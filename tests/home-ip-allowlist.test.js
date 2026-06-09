'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetConfig = jest.fn();
jest.mock('../config/cosa.config', () => ({
  getConfig: (...a) => mockGetConfig(...a),
}));

const mockExec        = jest.fn();
const mockIsConnected = jest.fn();
jest.mock('../src/ssh-backend', () => ({
  exec:        (...a) => mockExec(...a),
  isConnected: (...a) => mockIsConnected(...a),
}));

const mockSendEmail = jest.fn();
jest.mock('../src/email-gateway', () => ({
  sendEmail: (...a) => mockSendEmail(...a),
}));

jest.mock('../src/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const {
  parseHomeIps,
  ipv6Prefix64,
  computeAllowlist,
  readHomeIpState,
  writeHomeIpState,
  applyHomeIpUpdate,
  handleHomeIpEmail,
  HOME_IP_RE,
} = require('../src/home-ip-allowlist');

// ---------------------------------------------------------------------------
// Shared config fixture
// ---------------------------------------------------------------------------

let dataDir;

function buildConfig(overrides = {}) {
  return {
    env: { dataDir },
    appliance: {
      operator: { email: 'operator@gmail.com' },
      tools: {
        internet_ip_watch: {
          env_file_path: '/home/baanbaan/baan-baan-merchant/v2/.env',
          service_names: ['baanbaan', 'marketing-engine'],
        },
        home_ip_update: {
          enabled: true,
          allowlist_key: 'ALLOWED_MERCHANT_IPS',
          restart_service_on_change: true,
          service_names: ['baanbaan', 'marketing-engine'],
          ...overrides,
        },
      },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosa-homeip-'));
  mockGetConfig.mockReturnValue(buildConfig());
  mockIsConnected.mockReturnValue(true);
  mockSendEmail.mockResolvedValue(undefined);
});

afterEach(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ---------------------------------------------------------------------------
// parseHomeIps
// ---------------------------------------------------------------------------

describe('parseHomeIps', () => {
  it('extracts a bare IPv4', () => {
    expect(parseHomeIps('HOME-IP 172.56.108.188')).toEqual({ v4: '172.56.108.188', v6: null });
  });

  it('normalises a bare IPv6 host address to its /64 prefix', () => {
    expect(parseHomeIps('HOME-IP 2607:fb90:b280:7739:9484:6ed3:28d7:dcb0'))
      .toEqual({ v4: null, v6: '2607:fb90:b280:7739::/64' });
  });

  it('extracts both families from one message (v6 as /64)', () => {
    const r = parseHomeIps('HOMEIP 172.56.108.188 and 2607:fb90:b280:7739:9484:6ed3:28d7:dcb0');
    expect(r).toEqual({ v4: '172.56.108.188', v6: '2607:fb90:b280:7739::/64' });
  });

  it('accepts an explicit IPv6 /64 CIDR and keeps it as the /64', () => {
    expect(parseHomeIps('HOME-IP 2607:fb90:b280:7739::/64').v6).toBe('2607:fb90:b280:7739::/64');
  });

  it('handles comma-separated addresses', () => {
    const r = parseHomeIps('HOME-IP: 10.0.0.5, 2001:db8:abcd:1234::5');
    expect(r.v4).toBe('10.0.0.5');
    expect(r.v6).toBe('2001:db8:abcd:1234::/64');
  });

  it('strips brackets around an IPv6 literal', () => {
    expect(parseHomeIps('HOME-IP [2607:fb90:b280:7739:1:2:3:4]').v6).toBe('2607:fb90:b280:7739::/64');
  });

  it('ignores invalid / out-of-range addresses and prose', () => {
    expect(parseHomeIps('HOME-IP please use 999.999.1.1 soon')).toEqual({ v4: null, v6: null });
  });

  it('returns nulls for non-string input', () => {
    expect(parseHomeIps(undefined)).toEqual({ v4: null, v6: null });
  });

  it('takes the first valid address of each family', () => {
    const r = parseHomeIps('1.2.3.4 5.6.7.8');
    expect(r.v4).toBe('1.2.3.4');
  });
});

describe('ipv6Prefix64', () => {
  it('reduces a full host address to its /64 prefix', () => {
    expect(ipv6Prefix64('2607:fb90:b280:7739:127:2d21:c79:94ea')).toBe('2607:fb90:b280:7739::/64');
  });
  it('reduces a rotated host in the same /64 to the same prefix', () => {
    // The two addresses that churned in production were both in :7739::/64.
    expect(ipv6Prefix64('2607:fb90:b280:7739:a9c7:6987:ab8e:e6d4')).toBe('2607:fb90:b280:7739::/64');
  });
  it('is idempotent on an existing /64 CIDR', () => {
    expect(ipv6Prefix64('2607:fb90:b280:7739::/64')).toBe('2607:fb90:b280:7739::/64');
  });
  it('strips a zone id', () => {
    expect(ipv6Prefix64('2001:db8:1:2:3:4:5:6%eth0')).toBe('2001:db8:1:2::/64');
  });
  it('returns null for a non-IPv6 value', () => {
    expect(ipv6Prefix64('172.56.108.188')).toBeNull();
    expect(ipv6Prefix64('not-an-ip')).toBeNull();
  });
});

describe('HOME_IP_RE', () => {
  it('matches HOME-IP and HOMEIP, case-insensitively', () => {
    expect(HOME_IP_RE.test('home-ip 1.2.3.4')).toBe(true);
    expect(HOME_IP_RE.test('Subject: HOMEIP update')).toBe(true);
  });
  it('matches the natural "home IP" phrasing with a space (the real-world case)', () => {
    expect(HOME_IP_RE.test('please update my home IP address to 172.56.108.188')).toBe(true);
    expect(HOME_IP_RE.test('My Home IP changed')).toBe(true);
  });
  it('does not match unrelated text', () => {
    expect(HOME_IP_RE.test('please restart the POS')).toBe(false);
  });
  it('does not match when punctuation separates the words', () => {
    expect(HOME_IP_RE.test('I am home. IP stuff later.')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeAllowlist (pure)
// ---------------------------------------------------------------------------

describe('computeAllowlist', () => {
  it('preserves the restaurant entry and replaces both home entries', () => {
    const out = computeAllowlist(
      '198.51.100.10,1.1.1.1,2607:old::1',
      { v4: '1.1.1.1', v6: '2607:old::1' },
      { v4: '172.56.108.188', v6: '2607:new::2' },
    );
    expect(out).toBe('198.51.100.10,172.56.108.188,2607:new::2');
  });

  it('updates only the family present in the email, leaving the other home entry intact', () => {
    const out = computeAllowlist(
      '198.51.100.10,1.1.1.1,2607:old::1',
      { v4: '1.1.1.1', v6: '2607:old::1' },
      { v4: '2.2.2.2', v6: null },
    );
    expect(out).toBe('198.51.100.10,2607:old::1,2.2.2.2');
  });

  it('de-dupes when the new IP is already present', () => {
    const out = computeAllowlist(
      '198.51.100.10,172.56.108.188',
      { v4: null, v6: null },
      { v4: '172.56.108.188', v6: null },
    );
    expect(out).toBe('198.51.100.10,172.56.108.188');
  });

  it('appends on first run when there is no prior home IP', () => {
    const out = computeAllowlist(
      '198.51.100.10',
      { v4: null, v6: null },
      { v4: '172.56.108.188', v6: '2607:new::2' },
    );
    expect(out).toBe('198.51.100.10,172.56.108.188,2607:new::2');
  });

  it('handles an empty current value', () => {
    expect(computeAllowlist('', { v4: null, v6: null }, { v4: '1.2.3.4', v6: null }))
      .toBe('1.2.3.4');
  });
});

// ---------------------------------------------------------------------------
// state persistence
// ---------------------------------------------------------------------------

describe('home-ip state', () => {
  it('returns nulls when no state file exists', () => {
    expect(readHomeIpState()).toEqual({ v4: null, v6: null, lastUpdatedAt: null });
  });

  it('round-trips written state', () => {
    writeHomeIpState({ v4: '1.2.3.4', v6: 'fe80::1', lastUpdatedAt: '2026-06-06T00:00:00.000Z' });
    expect(readHomeIpState()).toEqual({ v4: '1.2.3.4', v6: 'fe80::1', lastUpdatedAt: '2026-06-06T00:00:00.000Z' });
  });
});

// ---------------------------------------------------------------------------
// applyHomeIpUpdate
// ---------------------------------------------------------------------------

describe('applyHomeIpUpdate', () => {
  /** Wire mockExec to a sequence: grep -q (exists), grep (read), sed, restart*. */
  function wireExec({ exists = 0, currentLine = 'ALLOWED_MERCHANT_IPS=198.51.100.10', sed = 0, restart = 0 } = {}) {
    mockExec.mockImplementation((cmd) => {
      if (cmd.startsWith('grep -q')) return Promise.resolve({ stdout: '', stderr: '', exitCode: exists });
      if (cmd.startsWith('grep '))   return Promise.resolve({ stdout: currentLine, stderr: '', exitCode: 0 });
      if (cmd.startsWith('sed '))    return Promise.resolve({ stdout: '', stderr: 'boom', exitCode: sed });
      if (cmd.includes('systemctl restart')) return Promise.resolve({ stdout: '', stderr: 'svc', exitCode: restart });
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });
  }

  it('updates the allowlist and restarts both services on the happy path', async () => {
    wireExec({ currentLine: 'ALLOWED_MERCHANT_IPS=198.51.100.10' });
    const r = await applyHomeIpUpdate({ v4: '172.56.108.188', v6: '2607:new::2' });

    expect(r.success).toBe(true);
    expect(r.oldList).toBe('198.51.100.10');
    expect(r.newList).toBe('198.51.100.10,172.56.108.188,2607:new::2');
    expect(r.restarted).toEqual(['baanbaan', 'marketing-engine']);

    // The sed command must carry the computed value.
    const sedCall = mockExec.mock.calls.find(([c]) => c.startsWith('sed '));
    expect(sedCall[0]).toContain('ALLOWED_MERCHANT_IPS=198.51.100.10,172.56.108.188,2607:new::2');

    // State persisted.
    expect(readHomeIpState()).toMatchObject({ v4: '172.56.108.188', v6: '2607:new::2' });
  });

  it('replaces a previously-applied home IP rather than appending', async () => {
    writeHomeIpState({ v4: '172.56.106.1', v6: null, lastUpdatedAt: null });
    wireExec({ currentLine: 'ALLOWED_MERCHANT_IPS=198.51.100.10,172.56.106.1' });
    const r = await applyHomeIpUpdate({ v4: '172.56.108.188', v6: null });

    expect(r.success).toBe(true);
    expect(r.newList).toBe('198.51.100.10,172.56.108.188');
  });

  it('fails cleanly when SSH is not connected', async () => {
    mockIsConnected.mockReturnValue(false);
    const r = await applyHomeIpUpdate({ v4: '1.2.3.4', v6: null });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/SSH not connected/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('fails when the allowlist key is absent (never creates it)', async () => {
    wireExec({ exists: 1 });
    const r = await applyHomeIpUpdate({ v4: '1.2.3.4', v6: null });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not found/);
    // Only the existence check ran — no sed write.
    expect(mockExec.mock.calls.some(([c]) => c.startsWith('sed '))).toBe(false);
  });

  it('rejects when no valid IP is supplied', async () => {
    const r = await applyHomeIpUpdate({ v4: null, v6: null });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/No valid home IP/);
  });

  it('is disabled via config', async () => {
    mockGetConfig.mockReturnValue(buildConfig({ enabled: false }));
    const r = await applyHomeIpUpdate({ v4: '1.2.3.4', v6: null });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/disabled/);
  });

  it('surfaces a sed failure without restarting services', async () => {
    wireExec({ sed: 1 });
    const r = await applyHomeIpUpdate({ v4: '172.56.108.188', v6: null });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/sed failed/);
    expect(mockExec.mock.calls.some(([c]) => c.includes('systemctl restart'))).toBe(false);
  });

  it('records a restart failure as a warning but still succeeds', async () => {
    wireExec({ restart: 1 });
    const r = await applyHomeIpUpdate({ v4: '172.56.108.188', v6: null });
    expect(r.success).toBe(true);
    expect(r.restarted).toEqual([]);
    expect(r.errors.join(' ')).toMatch(/restart baanbaan failed/);
  });

  it('skips a service name containing shell metacharacters', async () => {
    mockGetConfig.mockReturnValue(buildConfig({ service_names: ['baanbaan; rm -rf /'] }));
    wireExec({});
    const r = await applyHomeIpUpdate({ v4: '172.56.108.188', v6: null });
    expect(r.success).toBe(true);
    expect(r.restarted).toEqual([]);
    expect(r.errors.join(' ')).toMatch(/unsafe service name/i);
    expect(mockExec.mock.calls.some(([c]) => c.includes('systemctl restart'))).toBe(false);
  });

  it('no-ops (no sed) when the computed list equals the current list', async () => {
    writeHomeIpState({ v4: '172.56.108.188', v6: null, lastUpdatedAt: null });
    wireExec({ currentLine: 'ALLOWED_MERCHANT_IPS=198.51.100.10,172.56.108.188' });
    const r = await applyHomeIpUpdate({ v4: '172.56.108.188', v6: null });
    expect(r.success).toBe(true);
    expect(r.restarted).toEqual([]);
    expect(mockExec.mock.calls.some(([c]) => c.startsWith('sed '))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleHomeIpEmail
// ---------------------------------------------------------------------------

describe('handleHomeIpEmail', () => {
  function wireHappyExec() {
    mockExec.mockImplementation((cmd) => {
      if (cmd.startsWith('grep -q')) return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      if (cmd.startsWith('grep '))   return Promise.resolve({ stdout: 'ALLOWED_MERCHANT_IPS=198.51.100.10', stderr: '', exitCode: 0 });
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });
  }

  it('applies the update and emails a confirmation to the operator', async () => {
    wireHappyExec();
    await handleHomeIpEmail({
      from: 'operator@gmail.com',
      subject: 'HOME-IP',
      body: '172.56.108.188 2607:fb90:b280:7739:1:2:3:4',
      messageId: '<abc@mail>',
    });

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const sent = mockSendEmail.mock.calls[0][0];
    expect(sent.to).toBe('operator@gmail.com');
    expect(sent.subject).toMatch(/Home IP updated/);
    expect(sent.text).toContain('198.51.100.10,172.56.108.188,2607:fb90:b280:7739::/64');
    expect(sent.inReplyTo).toBe('<abc@mail>');
  });

  it('parses an IP out of a natural-language prose body', async () => {
    wireHappyExec();
    await handleHomeIpEmail({
      from: 'operator@gmail.com',
      subject: '',
      body: 'Hi COSA, my home IP address changed to 172.56.108.188 — please update it. Thanks!',
      messageId: null,
    });
    const sent = mockSendEmail.mock.calls[0][0];
    expect(sent.subject).toMatch(/Home IP updated/);
    expect(sent.text).toContain('198.51.100.10,172.56.108.188');
  });

  it('replies with guidance when no valid IP is found', async () => {
    await handleHomeIpEmail({ from: 'operator@gmail.com', subject: 'HOME-IP', body: 'my ip changed', messageId: null });
    expect(mockExec).not.toHaveBeenCalled();
    const sent = mockSendEmail.mock.calls[0][0];
    expect(sent.subject).toMatch(/no valid address/i);
  });

  it('emails a FAILED notice when the update fails', async () => {
    mockIsConnected.mockReturnValue(false);
    await handleHomeIpEmail({ from: 'operator@gmail.com', subject: 'HOME-IP', body: '172.56.108.188', messageId: null });
    const sent = mockSendEmail.mock.calls[0][0];
    expect(sent.subject).toMatch(/FAILED/);
    expect(sent.text).toMatch(/SSH not connected/);
  });
});
