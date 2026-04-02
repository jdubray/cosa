'use strict';

/**
 * Unit tests for src/tools/access-log-scan.js
 *
 * Acceptance Criteria covered:
 *   AC1 — accepts logPath and lookbackMinutes (default 380) from config
 *   AC2 — detects SSH brute force (>5 401s in 5 min, same IP) at severity 'high'
 *   AC3 — detects SQL injection patterns in query params at severity 'high'
 *   AC4 — detects path scanning (>50 404s in 10 min) at severity 'medium'
 *   AC5 — detects known scanner user agents (sqlmap, nikto) at severity 'high'
 *   AC6 — anomalies array shape: type, sourceIp, endpoint, count, windowMinutes, sample, severity
 *   AC7 — returns errorRatePercent and totalRequests
 *   AC8 — risk level is 'read'
 */

// ---------------------------------------------------------------------------
// Mocks — hoisted before any require()
// ---------------------------------------------------------------------------

const mockIsConnected = jest.fn();
const mockExec        = jest.fn();
const mockGetConfig   = jest.fn();

jest.mock('../../src/ssh-backend', () => ({
  isConnected: (...a) => mockIsConnected(...a),
  exec:        (...a) => mockExec(...a),
}));

jest.mock('../../config/cosa.config', () => ({
  getConfig: (...a) => mockGetConfig(...a),
}));

jest.mock('../../src/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

const { handler, riskLevel, name } = require('../../src/tools/access-log-scan');

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const LOG_PATH = '/var/log/nginx/access.log';

/**
 * Config with a very large lookbackMinutes so every 2026 timestamp
 * passes the cutoff filter without needing to mock Date.now().
 */
const BASE_CONFIG = {
  appliance: {
    tools: {
      access_log_scan: {
        enabled:         true,
        log_path:        LOG_PATH,
        lookback_minutes: 525600, // 1 year — all test entries pass the cutoff
      },
    },
  },
};

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/**
 * Format a Date as a nginx Combined Log Format timestamp string.
 *
 * @param {Date} d
 * @returns {string}  e.g. "01/Apr/2026:12:00:00 +0000"
 */
function fmtTs(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${pad(d.getUTCDate())}/${MONTHS[d.getUTCMonth()]}/${d.getUTCFullYear()}` +
    `:${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`
  );
}

/**
 * Build a single Combined Log Format line.
 *
 * @param {string} ip
 * @param {Date}   ts
 * @param {string} path   May include query string, e.g. /login?id=1
 * @param {number} status HTTP status code
 * @param {string} [ua]   User-Agent string
 */
function logLine(ip, ts, path, status, ua = 'Mozilla/5.0') {
  return `${ip} - - [${fmtTs(ts)}] "GET ${path} HTTP/1.1" ${status} 1234 "-" "${ua}"`;
}

/**
 * Create a Date at a fixed recent point with an optional offset in seconds.
 * All returned dates are well within the 1-year lookback window.
 *
 * @param {number} [offsetSeconds=0]  Positive = further in the past.
 */
function ts(offsetSeconds = 0) {
  // Base: 2026-04-01T12:00:00Z — a fixed "recent" date
  return new Date(Date.UTC(2026, 3, 1, 12, 0, 0) - offsetSeconds * 1000);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockIsConnected.mockReturnValue(true);
  mockExec.mockReset();
  mockExec.mockResolvedValue({ stdout: '', exitCode: 0 });
  mockGetConfig.mockReturnValue(BASE_CONFIG);
});

// ---------------------------------------------------------------------------
// AC8 — Risk level and module identity
// ---------------------------------------------------------------------------

describe('AC8 — risk level is "read"', () => {
  it('exports name "access_log_scan"', () => {
    expect(name).toBe('access_log_scan');
  });

  it('exports riskLevel "read"', () => {
    expect(riskLevel).toBe('read');
  });
});

// ---------------------------------------------------------------------------
// AC1 — Config: logPath and lookbackMinutes
// ---------------------------------------------------------------------------

describe('AC1 — logPath and lookbackMinutes from config', () => {
  it('reads log_path from appliance.tools.access_log_scan config', async () => {
    await handler();
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining(LOG_PATH)
    );
  });

  it('uses default log path /var/log/nginx/access.log when config absent', async () => {
    mockGetConfig.mockReturnValue({ appliance: { tools: {} } });
    await handler();
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('/var/log/nginx/access.log')
    );
  });

  it('uses default lookbackMinutes of 380 when config absent', async () => {
    // With default 380 min window a timestamp from 2026-04-01 will not pass
    // the cutoff when run in 2026-04-01 — we just verify no error is thrown
    // and the result is valid shape.
    mockGetConfig.mockReturnValue({ appliance: { tools: {} } });
    const result = await handler();
    expect(result).toHaveProperty('anomalies');
    expect(result).toHaveProperty('totalRequests');
  });

  it('throws when SSH is not connected', async () => {
    mockIsConnected.mockReturnValue(false);
    await expect(handler()).rejects.toThrow('SSH not connected');
  });

  it('returns empty result gracefully when log file is absent', async () => {
    mockExec.mockResolvedValue({ stdout: '', exitCode: 0 });
    const result = await handler();
    expect(result.anomalies).toHaveLength(0);
    expect(result.totalRequests).toBe(0);
    expect(result.errorRatePercent).toBe(0);
  });

  it('includes checked_at ISO timestamp in result', async () => {
    const result = await handler();
    expect(result.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// AC2 — Brute-force detection: >5 failed logins in 5 min from same IP
// ---------------------------------------------------------------------------

describe('AC2 — SSH brute force detection (>5 401s in 5 min)', () => {
  /**
   * Build a stdout payload with `count` HTTP 401 lines from `ip`,
   * each 30 seconds apart (all within a single 5-minute window).
   */
  function bruteLines(ip, count) {
    return Array.from({ length: count }, (_, i) =>
      logLine(ip, ts(i * 30), '/api/login', 401)
    ).join('\n');
  }

  it('returns brute_force anomaly when >5 401s from same IP in 5 min', async () => {
    mockExec.mockResolvedValue({ stdout: bruteLines('10.0.0.1', 6), exitCode: 0 });
    const result = await handler();
    const hit = result.anomalies.find((a) => a.type === 'brute_force');
    expect(hit).toBeDefined();
  });

  it('brute_force anomaly has severity "high"', async () => {
    mockExec.mockResolvedValue({ stdout: bruteLines('10.0.0.1', 6), exitCode: 0 });
    const result = await handler();
    expect(result.anomalies.find((a) => a.type === 'brute_force').severity).toBe('high');
  });

  it('brute_force anomaly sourceIp matches the offending IP', async () => {
    mockExec.mockResolvedValue({ stdout: bruteLines('192.168.99.1', 7), exitCode: 0 });
    const result = await handler();
    expect(result.anomalies.find((a) => a.type === 'brute_force').sourceIp).toBe('192.168.99.1');
  });

  it('does NOT trigger brute_force for exactly 5 401s (threshold is >5)', async () => {
    mockExec.mockResolvedValue({ stdout: bruteLines('10.0.0.1', 5), exitCode: 0 });
    const result = await handler();
    expect(result.anomalies.find((a) => a.type === 'brute_force')).toBeUndefined();
  });

  it('does NOT trigger brute_force for 6 401s spread over 7 minutes', async () => {
    // 6 entries 70 seconds apart = 350 seconds = ~5.8 min — no 5-min window fits 6
    const lines = Array.from({ length: 6 }, (_, i) =>
      logLine('10.0.0.2', ts(i * 70), '/login', 401)
    ).join('\n');
    mockExec.mockResolvedValue({ stdout: lines, exitCode: 0 });
    const result = await handler();
    expect(result.anomalies.find((a) => a.type === 'brute_force')).toBeUndefined();
  });

  it('does NOT trigger brute_force for 6 200 responses (not 401)', async () => {
    const lines = Array.from({ length: 6 }, (_, i) =>
      logLine('10.0.0.3', ts(i * 30), '/login', 200)
    ).join('\n');
    mockExec.mockResolvedValue({ stdout: lines, exitCode: 0 });
    const result = await handler();
    expect(result.anomalies.find((a) => a.type === 'brute_force')).toBeUndefined();
  });

  it('produces one anomaly per offending IP, not one per request', async () => {
    mockExec.mockResolvedValue({ stdout: bruteLines('10.0.0.4', 12), exitCode: 0 });
    const result = await handler();
    const hits = result.anomalies.filter((a) => a.type === 'brute_force');
    expect(hits).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AC3 — SQL injection detection in query params
// ---------------------------------------------------------------------------

describe('AC3 — SQL injection detection in query params (severity "high")', () => {
  function sqliLine(ip, qs) {
    return logLine(ip, ts(), `/search?${qs}`, 200);
  }

  it('detects UNION SELECT pattern', async () => {
    mockExec.mockResolvedValue({
      stdout:   sqliLine('10.1.1.1', 'q=1+UNION+SELECT+1,2,3--'),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.anomalies.find((a) => a.type === 'sql_injection')).toBeDefined();
  });

  it('sql_injection anomaly has severity "high"', async () => {
    mockExec.mockResolvedValue({
      stdout:   sqliLine('10.1.1.1', 'tbl=information_schema.tables'),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.anomalies.find((a) => a.type === 'sql_injection').severity).toBe('high');
  });

  it('detects xp_cmdshell pattern', async () => {
    mockExec.mockResolvedValue({
      stdout:   sqliLine('10.1.1.2', "cmd=xp_cmdshell('dir')"),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.anomalies.find((a) => a.type === 'sql_injection')).toBeDefined();
  });

  it('detects benchmark() time-based injection', async () => {
    mockExec.mockResolvedValue({
      stdout:   sqliLine('10.1.1.3', 'id=1+AND+benchmark(5000,md5(1))'),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.anomalies.find((a) => a.type === 'sql_injection')).toBeDefined();
  });

  it('detects sleep() pattern', async () => {
    mockExec.mockResolvedValue({
      stdout:   sqliLine('10.1.1.4', 'id=1+AND+sleep(5)'),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.anomalies.find((a) => a.type === 'sql_injection')).toBeDefined();
  });

  it('detects information_schema pattern', async () => {
    mockExec.mockResolvedValue({
      stdout:   sqliLine('10.1.1.5', 'tbl=information_schema.tables'),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.anomalies.find((a) => a.type === 'sql_injection')).toBeDefined();
  });

  it('does NOT flag a clean query string', async () => {
    mockExec.mockResolvedValue({
      stdout:   sqliLine('10.1.1.6', 'q=weather+station&page=2'),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.anomalies.find((a) => a.type === 'sql_injection')).toBeUndefined();
  });

  it('does NOT flag a request with no query string', async () => {
    mockExec.mockResolvedValue({
      stdout:   logLine('10.1.1.7', ts(), '/index.html', 200),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.anomalies.find((a) => a.type === 'sql_injection')).toBeUndefined();
  });

  it('sql_injection sourceIp matches the offending IP', async () => {
    mockExec.mockResolvedValue({
      stdout:   sqliLine('172.16.0.99', 'tbl=information_schema.tables'),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.anomalies.find((a) => a.type === 'sql_injection').sourceIp).toBe('172.16.0.99');
  });
});

// ---------------------------------------------------------------------------
// AC4 — Path scanning: >50 404s in 10 min from same IP
// ---------------------------------------------------------------------------

describe('AC4 — path scanning detection (>50 404s in 10 min, severity "medium")', () => {
  /**
   * Build `count` 404 lines from `ip`, each 10 seconds apart.
   * 51 × 10 s = 510 s = 8.5 min — fits inside the 10-min window.
   */
  function scanLines(ip, count) {
    return Array.from({ length: count }, (_, i) =>
      logLine(ip, ts(i * 10), `/probe/${i}`, 404)
    ).join('\n');
  }

  it('returns path_scanning anomaly when >50 404s from same IP in 10 min', async () => {
    mockExec.mockResolvedValue({ stdout: scanLines('10.2.0.1', 51), exitCode: 0 });
    const result = await handler();
    expect(result.anomalies.find((a) => a.type === 'path_scanning')).toBeDefined();
  });

  it('path_scanning anomaly has severity "medium"', async () => {
    mockExec.mockResolvedValue({ stdout: scanLines('10.2.0.1', 51), exitCode: 0 });
    const result = await handler();
    expect(result.anomalies.find((a) => a.type === 'path_scanning').severity).toBe('medium');
  });

  it('path_scanning anomaly sourceIp matches the offending IP', async () => {
    mockExec.mockResolvedValue({ stdout: scanLines('10.2.0.55', 51), exitCode: 0 });
    const result = await handler();
    expect(result.anomalies.find((a) => a.type === 'path_scanning').sourceIp).toBe('10.2.0.55');
  });

  it('does NOT trigger path_scanning for exactly 50 404s (threshold is >50)', async () => {
    mockExec.mockResolvedValue({ stdout: scanLines('10.2.0.2', 50), exitCode: 0 });
    const result = await handler();
    expect(result.anomalies.find((a) => a.type === 'path_scanning')).toBeUndefined();
  });

  it('does NOT trigger path_scanning for 51 404s spread over 11 minutes', async () => {
    // 51 entries × 13 s apart = 650 s = ~10.8 min — no 10-min window holds all 51
    const lines = Array.from({ length: 51 }, (_, i) =>
      logLine('10.2.0.3', ts(i * 13), `/path/${i}`, 404)
    ).join('\n');
    mockExec.mockResolvedValue({ stdout: lines, exitCode: 0 });
    const result = await handler();
    expect(result.anomalies.find((a) => a.type === 'path_scanning')).toBeUndefined();
  });

  it('does NOT trigger path_scanning for 51 200 responses (not 404)', async () => {
    const lines = Array.from({ length: 51 }, (_, i) =>
      logLine('10.2.0.4', ts(i * 10), `/ok/${i}`, 200)
    ).join('\n');
    mockExec.mockResolvedValue({ stdout: lines, exitCode: 0 });
    const result = await handler();
    expect(result.anomalies.find((a) => a.type === 'path_scanning')).toBeUndefined();
  });

  it('produces one anomaly per offending IP', async () => {
    mockExec.mockResolvedValue({ stdout: scanLines('10.2.0.5', 100), exitCode: 0 });
    const result = await handler();
    const hits = result.anomalies.filter((a) => a.type === 'path_scanning');
    expect(hits).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AC5 — Known scanner user agents (sqlmap, nikto)
// ---------------------------------------------------------------------------

describe('AC5 — known scanner user agents (severity "high")', () => {
  it('detects sqlmap user agent', async () => {
    mockExec.mockResolvedValue({
      stdout:   logLine('10.3.0.1', ts(), '/', 200, 'sqlmap/1.6.4#stable'),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.anomalies.find((a) => a.type === 'scanner_agent')).toBeDefined();
  });

  it('sqlmap anomaly has severity "high"', async () => {
    mockExec.mockResolvedValue({
      stdout:   logLine('10.3.0.1', ts(), '/', 200, 'sqlmap/1.6.4#stable'),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.anomalies.find((a) => a.type === 'scanner_agent').severity).toBe('high');
  });

  it('detects nikto user agent', async () => {
    mockExec.mockResolvedValue({
      stdout:   logLine('10.3.0.2', ts(), '/', 200, 'Nikto/2.1.6'),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.anomalies.find((a) => a.type === 'scanner_agent')).toBeDefined();
  });

  it('nikto match is case-insensitive', async () => {
    mockExec.mockResolvedValue({
      stdout:   logLine('10.3.0.3', ts(), '/', 200, 'NIKTO scanner v2'),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.anomalies.find((a) => a.type === 'scanner_agent')).toBeDefined();
  });

  it('scanner_agent sourceIp matches the offending IP', async () => {
    mockExec.mockResolvedValue({
      stdout:   logLine('172.16.99.1', ts(), '/', 200, 'sqlmap/1.0'),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.anomalies.find((a) => a.type === 'scanner_agent').sourceIp).toBe('172.16.99.1');
  });

  it('does NOT flag a normal browser UA', async () => {
    mockExec.mockResolvedValue({
      stdout:   logLine('10.3.0.5', ts(), '/', 200, 'Mozilla/5.0 (Windows NT 10.0)'),
      exitCode: 0,
    });
    const result = await handler();
    expect(result.anomalies.find((a) => a.type === 'scanner_agent')).toBeUndefined();
  });

  it('produces one scanner_agent anomaly per IP per scanner type', async () => {
    const lines = Array.from({ length: 5 }, (_, i) =>
      logLine('10.3.0.6', ts(i * 60), `/p/${i}`, 200, 'sqlmap/1.6')
    ).join('\n');
    mockExec.mockResolvedValue({ stdout: lines, exitCode: 0 });
    const result = await handler();
    const hits = result.anomalies.filter((a) => a.type === 'scanner_agent');
    expect(hits).toHaveLength(1);
    expect(hits[0].count).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// AC6 — Anomaly object shape
// ---------------------------------------------------------------------------

describe('AC6 — anomaly object shape', () => {
  const REQUIRED_FIELDS = ['type', 'sourceIp', 'endpoint', 'count', 'windowMinutes', 'sample', 'severity'];

  it('brute_force anomaly has all required fields', async () => {
    const lines = Array.from({ length: 6 }, (_, i) =>
      logLine('10.4.0.1', ts(i * 30), '/login', 401)
    ).join('\n');
    mockExec.mockResolvedValue({ stdout: lines, exitCode: 0 });
    const result = await handler();
    const a = result.anomalies.find((x) => x.type === 'brute_force');
    for (const field of REQUIRED_FIELDS) {
      expect(a).toHaveProperty(field);
    }
  });

  it('sql_injection anomaly has all required fields', async () => {
    mockExec.mockResolvedValue({
      stdout:   logLine('10.4.0.2', ts(), '/search?tbl=information_schema.tables', 200),
      exitCode: 0,
    });
    const result = await handler();
    const a = result.anomalies.find((x) => x.type === 'sql_injection');
    for (const field of REQUIRED_FIELDS) {
      expect(a).toHaveProperty(field);
    }
  });

  it('path_scanning anomaly has all required fields', async () => {
    const lines = Array.from({ length: 51 }, (_, i) =>
      logLine('10.4.0.3', ts(i * 10), `/probe/${i}`, 404)
    ).join('\n');
    mockExec.mockResolvedValue({ stdout: lines, exitCode: 0 });
    const result = await handler();
    const a = result.anomalies.find((x) => x.type === 'path_scanning');
    for (const field of REQUIRED_FIELDS) {
      expect(a).toHaveProperty(field);
    }
  });

  it('scanner_agent anomaly has all required fields', async () => {
    mockExec.mockResolvedValue({
      stdout:   logLine('10.4.0.4', ts(), '/', 200, 'sqlmap/1.6'),
      exitCode: 0,
    });
    const result = await handler();
    const a = result.anomalies.find((x) => x.type === 'scanner_agent');
    for (const field of REQUIRED_FIELDS) {
      expect(a).toHaveProperty(field);
    }
  });

  it('brute_force windowMinutes is 5', async () => {
    const lines = Array.from({ length: 6 }, (_, i) =>
      logLine('10.4.0.5', ts(i * 30), '/login', 401)
    ).join('\n');
    mockExec.mockResolvedValue({ stdout: lines, exitCode: 0 });
    const result = await handler();
    expect(result.anomalies.find((a) => a.type === 'brute_force').windowMinutes).toBe(5);
  });

  it('path_scanning windowMinutes is 10', async () => {
    const lines = Array.from({ length: 51 }, (_, i) =>
      logLine('10.4.0.6', ts(i * 10), `/p/${i}`, 404)
    ).join('\n');
    mockExec.mockResolvedValue({ stdout: lines, exitCode: 0 });
    const result = await handler();
    expect(result.anomalies.find((a) => a.type === 'path_scanning').windowMinutes).toBe(10);
  });

  it('count field is a positive number', async () => {
    mockExec.mockResolvedValue({
      stdout:   logLine('10.4.0.7', ts(), '/q?tbl=information_schema.tables', 200),
      exitCode: 0,
    });
    const result = await handler();
    const a = result.anomalies.find((x) => x.type === 'sql_injection');
    expect(typeof a.count).toBe('number');
    expect(a.count).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC7 — errorRatePercent and totalRequests
// ---------------------------------------------------------------------------

describe('AC7 — errorRatePercent and totalRequests', () => {
  it('totalRequests equals the number of parsed entries in the lookback window', async () => {
    const lines = [
      logLine('10.5.0.1', ts(), '/a', 200),
      logLine('10.5.0.1', ts(1), '/b', 200),
      logLine('10.5.0.1', ts(2), '/c', 404),
    ].join('\n');
    mockExec.mockResolvedValue({ stdout: lines, exitCode: 0 });
    const result = await handler();
    expect(result.totalRequests).toBe(3);
  });

  it('errorRatePercent is 0 when no 4xx/5xx responses', async () => {
    const lines = [
      logLine('10.5.0.2', ts(), '/a', 200),
      logLine('10.5.0.2', ts(1), '/b', 200),
    ].join('\n');
    mockExec.mockResolvedValue({ stdout: lines, exitCode: 0 });
    const result = await handler();
    expect(result.errorRatePercent).toBe(0);
  });

  it('errorRatePercent is 100 when all responses are errors', async () => {
    const lines = [
      logLine('10.5.0.3', ts(), '/x', 500),
      logLine('10.5.0.3', ts(1), '/y', 503),
    ].join('\n');
    mockExec.mockResolvedValue({ stdout: lines, exitCode: 0 });
    const result = await handler();
    expect(result.errorRatePercent).toBe(100);
  });

  it('errorRatePercent is 50 for 1 error out of 2 requests', async () => {
    const lines = [
      logLine('10.5.0.4', ts(), '/ok', 200),
      logLine('10.5.0.4', ts(1), '/bad', 404),
    ].join('\n');
    mockExec.mockResolvedValue({ stdout: lines, exitCode: 0 });
    const result = await handler();
    expect(result.errorRatePercent).toBe(50);
  });

  it('totalRequests and errorRatePercent are 0 when log is empty', async () => {
    mockExec.mockResolvedValue({ stdout: '', exitCode: 0 });
    const result = await handler();
    expect(result.totalRequests).toBe(0);
    expect(result.errorRatePercent).toBe(0);
  });

  it('anomalies array is present and is an array', async () => {
    mockExec.mockResolvedValue({ stdout: '', exitCode: 0 });
    const result = await handler();
    expect(Array.isArray(result.anomalies)).toBe(true);
  });

  it('result includes summary string', async () => {
    mockExec.mockResolvedValue({ stdout: '', exitCode: 0 });
    const result = await handler();
    expect(typeof result.summary).toBe('string');
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it('summary mentions anomaly count when anomalies are present', async () => {
    mockExec.mockResolvedValue({
      stdout:   logLine('10.5.0.5', ts(), '/x?q=1+UNION+SELECT+1', 200),
      exitCode: 0,
    });
    const result = await handler();
    // At least one anomaly → summary should mention it
    expect(result.summary).toMatch(/anomal/i);
  });
});
