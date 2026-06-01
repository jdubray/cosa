'use strict';

/**
 * Unit tests for src/tools/host-ssh-audit.js
 *
 * Acceptance Criteria covered:
 *   AC1  — parseAuthEvents: extracts accepted publickey login (user, ip, method)
 *   AC2  — parseAuthEvents: ignores routine noise (session open/close, normal logout)
 *   AC3  — classifyMessage: classifies each failed/invalid/preauth shape correctly
 *   AC4  — detectAnomalies: accepted login from untrusted IP → critical
 *   AC5  — detectAnomalies: accepted login as unexpected user (trusted IP) → critical
 *   AC6  — detectAnomalies: accepted login from trusted IP + user → no anomaly
 *   AC7  — detectAnomalies: any failed attempt → high, grouped per IP with count
 *   AC8  — handler: clean journal → anomalies: [] and 0 failedCount
 *   AC9  — handler: untrusted accepted + brute force → both anomaly types
 *   AC10 — handler: returns { skipped: true } when enabled: false
 *   AC11 — handler: filters events outside the lookback window
 *   AC12 — handler: journalctl spawn failure propagates as a thrown error
 *   AC13 — riskLevel is 'read' and name is 'host_ssh_audit'
 */

// ---------------------------------------------------------------------------
// Mocks — declared before any require() so Jest hoisting works
// ---------------------------------------------------------------------------

const mockExecFile  = jest.fn();
const mockGetConfig = jest.fn();
const mockWarn      = jest.fn();

jest.mock('child_process', () => ({
  execFile: (...a) => mockExecFile(...a),
}));

jest.mock('../../config/cosa.config', () => ({
  getConfig: (...a) => mockGetConfig(...a),
}));

jest.mock('../../src/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info:  jest.fn(),
    warn:  (...a) => mockWarn(...a),
    error: jest.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

const tool = require('../../src/tools/host-ssh-audit');
const {
  handler,
  riskLevel,
  name,
  parseAuthEvents,
  classifyMessage,
  detectAnomalies,
} = tool;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TRUSTED_IP   = '192.168.1.122';
const UNTRUSTED_IP = '203.0.113.9';

const LINE_ACCEPTED_TRUSTED =
  `2026-06-01T09:10:19-07:00 cosa sshd-session[73127]: Accepted publickey for cosa from ${TRUSTED_IP} port 50495 ssh2: ED25519 SHA256:abc`;
const LINE_SESSION_OPEN =
  '2026-06-01T09:10:19-07:00 cosa sshd-session[73127]: pam_unix(sshd:session): session opened for user cosa(uid=1000) by cosa(uid=0)';
const LINE_NORMAL_LOGOUT =
  '2026-06-01T09:11:00-07:00 cosa sshd-session[73127]: Disconnected from user cosa 192.168.1.122 port 50495';
const LINE_ACCEPTED_UNTRUSTED =
  `2026-06-01T03:00:00-07:00 cosa sshd-session[80001]: Accepted publickey for cosa from ${UNTRUSTED_IP} port 40000 ssh2: RSA SHA256:xyz`;
const LINE_FAILED_PASSWORD =
  `2026-06-01T03:01:00-07:00 cosa sshd[80010]: Failed password for invalid user admin from ${UNTRUSTED_IP} port 40001 ssh2`;
const LINE_INVALID_USER =
  `2026-06-01T03:01:01-07:00 cosa sshd[80010]: Invalid user admin from ${UNTRUSTED_IP} port 40001`;
const LINE_PREAUTH_CLOSED =
  `2026-06-01T03:02:00-07:00 cosa sshd[80020]: Connection closed by authenticating user root ${UNTRUSTED_IP} port 40002 [preauth]`;

function defaultConfig(overrides = {}) {
  return {
    appliance: {
      tools: {
        host_ssh_audit: {
          enabled:         true,
          trusted_ips:     [TRUSTED_IP],
          trusted_users:   ['cosa'],
          // Effectively unbounded so 2026-dated fixtures always fall inside the
          // window regardless of the test machine's wall clock. The lookback
          // filter has no upper bound — only a lower cutoff — so a huge value
          // lets every fixture through. Tests that exercise filtering override
          // this with a small value plus ancient fixtures.
          lookback_minutes: 100 * 365 * 24 * 60,
          ...overrides,
        },
      },
    },
  };
}

/** Make the mocked execFile resolve with the given stdout. */
function execFileReturns(stdout) {
  mockExecFile.mockImplementation((file, args, opts, cb) => cb(null, stdout, ''));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetConfig.mockReturnValue(defaultConfig());
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe('parseAuthEvents', () => {
  test('AC1: extracts an accepted publickey login', () => {
    const events = parseAuthEvents(LINE_ACCEPTED_TRUSTED);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind:   'accepted',
      method: 'publickey',
      user:   'cosa',
      ip:     TRUSTED_IP,
    });
    expect(events[0].ts.toISOString()).toBe('2026-06-01T16:10:19.000Z');
  });

  test('AC2: ignores session-open and normal-logout noise', () => {
    const stdout = [LINE_SESSION_OPEN, LINE_NORMAL_LOGOUT].join('\n');
    expect(parseAuthEvents(stdout)).toHaveLength(0);
  });

  test('AC2: ignores non-sshd journal identifiers', () => {
    const line = '2026-06-01T09:10:19-07:00 cosa systemd[1]: Accepted publickey for cosa from 1.2.3.4 port 5 ssh2';
    expect(parseAuthEvents(line)).toHaveLength(0);
  });
});

describe('classifyMessage', () => {
  test('AC3: failed password (invalid user)', () => {
    expect(classifyMessage(`Failed password for invalid user admin from ${UNTRUSTED_IP} port 40001 ssh2`))
      .toMatchObject({ kind: 'failed', subtype: 'failed_password', user: 'admin', ip: UNTRUSTED_IP });
  });

  test('AC3: invalid user', () => {
    expect(classifyMessage(`Invalid user admin from ${UNTRUSTED_IP} port 40001`))
      .toMatchObject({ kind: 'failed', subtype: 'invalid_user', user: 'admin', ip: UNTRUSTED_IP });
  });

  test('AC3: preauth connection closed', () => {
    expect(classifyMessage(`Connection closed by authenticating user root ${UNTRUSTED_IP} port 40002 [preauth]`))
      .toMatchObject({ kind: 'failed', subtype: 'preauth_closed', user: 'root', ip: UNTRUSTED_IP });
  });

  test('AC3: max authentication attempts exceeded', () => {
    expect(classifyMessage(`error: maximum authentication attempts exceeded for root from ${UNTRUSTED_IP} port 5 ssh2 [preauth]`))
      .toMatchObject({ kind: 'failed', subtype: 'max_attempts', user: 'root', ip: UNTRUSTED_IP });
  });

  test('AC3: routine session line is not an auth event', () => {
    expect(classifyMessage('pam_unix(sshd:session): session closed for user cosa')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

describe('detectAnomalies', () => {
  const opts = { trustedIps: [TRUSTED_IP], trustedUsers: ['cosa'] };

  test('AC4: accepted login from untrusted IP → critical', () => {
    const events = parseAuthEvents(LINE_ACCEPTED_UNTRUSTED);
    const anomalies = detectAnomalies(events, opts);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      type:     'untrusted_accepted_login',
      sourceIp: UNTRUSTED_IP,
      user:     'cosa',
      severity: 'critical',
    });
  });

  test('AC5: accepted login as unexpected user from trusted IP → critical', () => {
    const line = `2026-06-01T09:00:00-07:00 cosa sshd-session[1]: Accepted publickey for root from ${TRUSTED_IP} port 5 ssh2: ED25519 SHA256:k`;
    const anomalies = detectAnomalies(parseAuthEvents(line), opts);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      type:     'unexpected_user_login',
      user:     'root',
      severity: 'critical',
    });
  });

  test('AC6: accepted login from trusted IP + user → no anomaly', () => {
    const anomalies = detectAnomalies(parseAuthEvents(LINE_ACCEPTED_TRUSTED), opts);
    expect(anomalies).toHaveLength(0);
  });

  test('AC7: failed attempts are grouped per IP with a count, severity high', () => {
    const stdout = [LINE_FAILED_PASSWORD, LINE_INVALID_USER, LINE_PREAUTH_CLOSED].join('\n');
    const anomalies = detectAnomalies(parseAuthEvents(stdout), opts);
    const failed = anomalies.filter(a => a.type === 'failed_login_attempt');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      sourceIp: UNTRUSTED_IP,
      count:    3,
      severity: 'high',
    });
    expect(failed[0].user).toContain('admin');
    expect(failed[0].user).toContain('root');
  });
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

describe('handler', () => {
  test('AC8: clean journal → no anomalies', async () => {
    execFileReturns([LINE_ACCEPTED_TRUSTED, LINE_SESSION_OPEN, LINE_NORMAL_LOGOUT].join('\n'));
    const res = await handler();
    expect(res.anomalies).toHaveLength(0);
    expect(res.acceptedCount).toBe(1);
    expect(res.failedCount).toBe(0);
    expect(res.summary).toMatch(/No SSH anomalies/);
  });

  test('AC9: untrusted accepted + brute force → both anomaly types', async () => {
    execFileReturns([
      LINE_ACCEPTED_TRUSTED,
      LINE_ACCEPTED_UNTRUSTED,
      LINE_FAILED_PASSWORD,
      LINE_INVALID_USER,
    ].join('\n'));
    const res = await handler();
    const types = res.anomalies.map(a => a.type).sort();
    expect(types).toEqual(['failed_login_attempt', 'untrusted_accepted_login']);
    expect(res.acceptedCount).toBe(2);
    expect(res.failedCount).toBe(2);
  });

  test('AC10: returns { skipped: true } when enabled is false', async () => {
    mockGetConfig.mockReturnValue(defaultConfig({ enabled: false }));
    const res = await handler();
    expect(res).toEqual({ skipped: true });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  test('AC11: events older than the lookback window are filtered out', async () => {
    // 5-minute window; fixture lines are dated 2020, always far older than the
    // cutoff regardless of the test machine's wall clock, so none survive.
    const ancient = [
      `2020-01-01T03:00:00-07:00 cosa sshd-session[80001]: Accepted publickey for cosa from ${UNTRUSTED_IP} port 40000 ssh2: RSA SHA256:xyz`,
      `2020-01-01T03:01:00-07:00 cosa sshd[80010]: Failed password for invalid user admin from ${UNTRUSTED_IP} port 40001 ssh2`,
    ].join('\n');
    mockGetConfig.mockReturnValue(defaultConfig({ lookback_minutes: 5 }));
    execFileReturns(ancient);
    const res = await handler();
    expect(res.acceptedCount).toBe(0);
    expect(res.failedCount).toBe(0);
    expect(res.anomalies).toHaveLength(0);
  });

  test('AC12: journalctl failure propagates as a thrown error', async () => {
    mockExecFile.mockImplementation((file, args, opts, cb) =>
      cb(Object.assign(new Error('command not found'), { code: 'ENOENT' }), '', 'journalctl: not found'));
    await expect(handler()).rejects.toThrow(/journalctl read failed/);
  });

  test('AC13: tool metadata', () => {
    expect(name).toBe('host_ssh_audit');
    expect(riskLevel).toBe('read');
  });
});
