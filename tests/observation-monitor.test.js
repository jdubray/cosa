'use strict';

/**
 * Unit tests for src/observation-monitor.js — the data-driven observation
 * primitive: probe registry, threshold classification, template rendering,
 * and end-to-end monitor evaluation.
 */

const mockExec = jest.fn();
jest.mock('../src/ssh-backend', () => ({ exec: (...a) => mockExec(...a) }));
jest.mock('../src/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
const mockDbPath = jest.fn(() => '/home/baanbaan/baan-baan-merchant/v2/data/merchant.db');
const mockDnsMonitorCfg = jest.fn(() => ({ pihole_db_path: '/etc/pihole/pihole-FTL.db' }));
jest.mock('../config/cosa.config', () => ({
  getConfig: () => ({ appliance: { database: { path: mockDbPath() }, dns_monitor: mockDnsMonitorCfg() } }),
}));
const mockExecFile = jest.fn();
jest.mock('child_process', () => ({ execFile: (...a) => mockExecFile(...a) }));

const om = require('../src/observation-monitor');
const { classify, renderTemplate, PROBES, evaluateMonitor } = om;

beforeEach(() => jest.clearAllMocks());

describe('classify', () => {
  it('high before medium, default comparator gte', () => {
    const t = { comparator: 'gte', medium: 1, high: 2 };
    expect(classify(0, t)).toBe('none');
    expect(classify(1, t)).toBe('medium');
    expect(classify(2, t)).toBe('high');
    expect(classify(5, t)).toBe('high');
  });
  it('supports lt/lte/gt/eq comparators', () => {
    expect(classify(3, { comparator: 'lt', medium: 5 })).toBe('medium');
    expect(classify(5, { comparator: 'lte', medium: 5 })).toBe('medium');
    expect(classify(6, { comparator: 'gt', high: 5 })).toBe('high');
    expect(classify(7, { comparator: 'eq', medium: 7 })).toBe('medium');
  });
  it('none when no thresholds set', () => {
    expect(classify(999, {})).toBe('none');
  });
});

describe('renderTemplate', () => {
  it('substitutes known vars and leaves unknown placeholders intact', () => {
    expect(renderTemplate('sev={{severity}} v={{value}} x={{missing}}', { severity: 'high', value: 12 }))
      .toBe('sev=high v=12 x={{missing}}');
  });
  it('stringifies booleans', () => {
    expect(renderTemplate('{{undervoltage_now}}', { undervoltage_now: true })).toBe('true');
  });
});

describe('PROBES.vcgencmd_throttled', () => {
  it('clean flag → value 0', async () => {
    mockExec.mockResolvedValue({ stdout: 'throttled=0x0', exitCode: 0 });
    const r = await PROBES.vcgencmd_throttled();
    expect(r.value).toBe(0);
    expect(r.context.undervoltage_now).toBe(false);
    expect(r.context.undervoltage_occurred).toBe(false);
  });
  it('under-voltage occurred (0x10000) → value 1', async () => {
    mockExec.mockResolvedValue({ stdout: 'throttled=0x10000', exitCode: 0 });
    const r = await PROBES.vcgencmd_throttled();
    expect(r.value).toBe(1);
    expect(r.context.undervoltage_occurred).toBe(true);
    expect(r.context.undervoltage_now).toBe(false);
  });
  it('under-voltage now (0x1) → value 2', async () => {
    mockExec.mockResolvedValue({ stdout: 'throttled=0x50001', exitCode: 0 });
    const r = await PROBES.vcgencmd_throttled();
    expect(r.value).toBe(2);
    expect(r.context.undervoltage_now).toBe(true);
  });
  it('throws on unparseable output', async () => {
    mockExec.mockResolvedValue({ stdout: 'garbage', exitCode: 0 });
    await expect(PROBES.vcgencmd_throttled()).rejects.toMatchObject({ code: 'OBSERVATION_INVALID' });
  });
});

describe('PROBES.log_pattern_count', () => {
  it('builds an AND grep chain over the window and parses the count', async () => {
    mockExec.mockResolvedValue({ stdout: '7\n', exitCode: 0 });
    const r = await PROBES.log_pattern_count({
      unit: 'baanbaan.service', window_minutes: 60,
      patterns: ['"path":"/transfers"', 'The operation timed out.'],
    });
    expect(r.value).toBe(7);
    const cmd = mockExec.mock.calls[0][0];
    expect(cmd).toContain('journalctl -u \'baanbaan.service\'');
    expect(cmd).toContain('--since "60 minutes ago"');
    expect(cmd).toContain("grep -F '\"path\":\"/transfers\"'");
    expect(cmd).toContain("grep -Fc 'The operation timed out.'");  // last pattern uses -Fc
    expect(cmd.trim().endsWith('|| true')).toBe(true);
  });
  it('rejects an invalid unit name (no shell injection surface)', async () => {
    await expect(PROBES.log_pattern_count({ unit: 'baanbaan; rm -rf /', patterns: ['x'] }))
      .rejects.toMatchObject({ code: 'OBSERVATION_INVALID' });
    expect(mockExec).not.toHaveBeenCalled();
  });
  it('requires at least one pattern', async () => {
    await expect(PROBES.log_pattern_count({ unit: 'baanbaan.service' }))
      .rejects.toMatchObject({ code: 'OBSERVATION_INVALID' });
  });
  it('clamps an out-of-range window', async () => {
    mockExec.mockResolvedValue({ stdout: '0', exitCode: 0 });
    await PROBES.log_pattern_count({ unit: 'baanbaan.service', window_minutes: 99999, pattern: 'x' });
    expect(mockExec.mock.calls[0][0]).toContain('--since "1440 minutes ago"');
  });
});

describe('PROBES.ping_reachability', () => {
  it('parses 0% packet loss', async () => {
    mockExec.mockResolvedValue({
      stdout: '3 packets transmitted, 3 received, 0% packet loss, time 2003ms', exitCode: 0,
    });
    const r = await PROBES.ping_reachability({ host: '192.168.1.179' });
    expect(r.value).toBe(0);
    expect(r.context.packet_loss_pct).toBe(0);
  });
  it('parses partial packet loss', async () => {
    mockExec.mockResolvedValue({
      stdout: '3 packets transmitted, 2 received, 33% packet loss, time 2003ms', exitCode: 0,
    });
    const r = await PROBES.ping_reachability({ host: '192.168.1.179' });
    expect(r.value).toBe(33);
  });
  it('parses fractional packet loss as printed by iputils %g (regression 2026-08-11)', async () => {
    // 1 of 3 pings lost: iputils prints "33.3333% packet loss". The old integer
    // regex captured only the digits after the dot → value 3333 → false high alert.
    mockExec.mockResolvedValue({
      stdout: '3 packets transmitted, 2 received, 33.3333% packet loss, time 2005ms', exitCode: 0,
    });
    const r = await PROBES.ping_reachability({ host: '192.168.1.217' });
    expect(r.value).toBe(33);
    expect(r.context.packet_loss_pct).toBe(33);
  });
  it('parses fractional loss with duplicate/error annotations', async () => {
    mockExec.mockResolvedValue({
      stdout: '3 packets transmitted, 1 received, +2 errors, 66.6667% packet loss, time 2010ms', exitCode: 0,
    });
    const r = await PROBES.ping_reachability({ host: '192.168.1.217' });
    expect(r.value).toBe(67);
  });
  it('defaults to 100% loss when output is unparseable (host fully down)', async () => {
    mockExec.mockResolvedValue({ stdout: '', exitCode: 1 });
    const r = await PROBES.ping_reachability({ host: '192.168.1.179' });
    expect(r.value).toBe(100);
  });
  it('rejects a non-IPv4 host (no shell injection surface)', async () => {
    await expect(PROBES.ping_reachability({ host: '192.168.1.179; rm -rf /' }))
      .rejects.toMatchObject({ code: 'OBSERVATION_INVALID' });
    expect(mockExec).not.toHaveBeenCalled();
  });
  it('clamps an out-of-range count', async () => {
    mockExec.mockResolvedValue({ stdout: '0% packet loss', exitCode: 0 });
    await PROBES.ping_reachability({ host: '192.168.1.179', count: 999 });
    expect(mockExec.mock.calls[0][0]).toContain('ping -c 10');
  });
});

describe('evaluateMonitor', () => {
  it('evaluates the voltage monitor end-to-end and renders the report', async () => {
    mockExec.mockResolvedValue({ stdout: 'throttled=0x1', exitCode: 0 });
    const def = {
      id: 'pi_undervoltage', probe: 'vcgencmd_throttled', params: {},
      threshold: { comparator: 'gte', medium: 1, high: 2 },
      report_template: 'sev={{severity}} now={{undervoltage_now}} raw={{raw}}',
    };
    const res = await evaluateMonitor(def);
    expect(res.severity).toBe('high');
    expect(res.value).toBe(2);
    expect(res.report).toBe('sev=high now=true raw=0x1');
  });
  it('returns severity none and no report when under threshold', async () => {
    mockExec.mockResolvedValue({ stdout: 'throttled=0x0', exitCode: 0 });
    const res = await evaluateMonitor({
      id: 'pi_undervoltage', probe: 'vcgencmd_throttled',
      threshold: { comparator: 'gte', medium: 1, high: 2 }, report_template: 'x',
    });
    expect(res.severity).toBe('none');
    expect(res.report).toBeNull();
  });
  it('throws on an unknown probe type', async () => {
    await expect(evaluateMonitor({ id: 'x', probe: 'nope' }))
      .rejects.toMatchObject({ code: 'OBSERVATION_INVALID' });
  });
});

describe('PROBES.sqlite_scalar', () => {
  const COUNT_SQL = "SELECT COUNT(*) FROM payments WHERE processor_fee_cents IS NULL";

  it('runs the query read-only on stdin against the configured DB path', async () => {
    mockExec.mockResolvedValue({ stdout: '1627\n', exitCode: 0 });
    const r = await PROBES.sqlite_scalar({ sql: COUNT_SQL });
    expect(r.value).toBe(1627);
    expect(r.context.value).toBe(1627);

    const [cmd, stdin] = mockExec.mock.calls[0];
    expect(cmd).toBe('sqlite3 -readonly "/home/baanbaan/baan-baan-merchant/v2/data/merchant.db"');
    expect(stdin).toBe(COUNT_SQL);          // SQL never reaches the command line
  });

  it('parses only the first row of output', async () => {
    mockExec.mockResolvedValue({ stdout: '42\n99\n', exitCode: 0 });
    expect((await PROBES.sqlite_scalar({ sql: COUNT_SQL })).value).toBe(42);
  });

  it('throws when sqlite3 exits non-zero (e.g. no such table)', async () => {
    mockExec.mockResolvedValue({ stdout: '', stderr: 'Error: no such table: settings', exitCode: 1 });
    await expect(PROBES.sqlite_scalar({ sql: COUNT_SQL }))
      .rejects.toMatchObject({ code: 'OBSERVATION_INVALID' });
  });

  it('throws when the query returns a non-numeric value', async () => {
    mockExec.mockResolvedValue({ stdout: 'banana', exitCode: 0 });
    await expect(PROBES.sqlite_scalar({ sql: COUNT_SQL }))
      .rejects.toMatchObject({ code: 'OBSERVATION_INVALID' });
  });

  it.each([
    ['no sql',            undefined],
    ['not a SELECT',      'PRAGMA table_info(payments)'],
    ['multiple statements', "SELECT 1; DROP TABLE payments"],
    ['a comment',         "SELECT 1 -- DROP TABLE payments"],
    ['a write keyword',   "SELECT 1 FROM payments WHERE id IN (DELETE FROM payments)"],
    ['ATTACH',            "SELECT 1 FROM payments WHERE ATTACH DATABASE 'x'"],
    ['load_extension',    "SELECT load_extension('evil.so')"],
  ])('rejects %s without touching the appliance', async (_label, sql) => {
    await expect(PROBES.sqlite_scalar({ sql }))
      .rejects.toMatchObject({ code: 'OBSERVATION_INVALID' });
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('throws when appliance.database.path is not configured', async () => {
    mockDbPath.mockReturnValueOnce(undefined);
    await expect(PROBES.sqlite_scalar({ sql: COUNT_SQL }))
      .rejects.toMatchObject({ code: 'OBSERVATION_INVALID' });
    expect(mockExec).not.toHaveBeenCalled();
  });
});

describe('config/observation-monitors.js — payments_missing_processor_fee', () => {
  const defs = require('../config/observation-monitors');
  const def  = defs.find(d => d.id === 'payments_missing_processor_fee');

  it('is paused (Finix-side issue, 2026-09-21) but stays wired to the sqlite_scalar probe', () => {
    expect(def).toBeDefined();
    expect(def.enabled).toBe(false);
    expect(def.probe).toBe('sqlite_scalar');
    expect(PROBES[def.probe]).toBeInstanceOf(Function);
  });

  it('its SQL passes the probe validator', async () => {
    mockExec.mockResolvedValue({ stdout: '0', exitCode: 0 });
    await expect(PROBES.sqlite_scalar(def.params)).resolves.toMatchObject({ value: 0 });
  });

  it('classifies a healthy backlog as none and a stalled one as high', () => {
    expect(classify(3,    def.threshold)).toBe('none');
    expect(classify(25,   def.threshold)).toBe('medium');
    expect(classify(1627, def.threshold)).toBe('high');
  });
});

describe('PROBES.pihole_dns_scalar', () => {
  const TOP_CLIENT_SQL =
    "SELECT COUNT(*) AS n, client FROM queries WHERE timestamp >= strftime('%s','now') - 900 " +
    "GROUP BY client ORDER BY n DESC LIMIT 1";

  /** Simulate a local sqlite3 child: capture stdin, reply with the given output. */
  function stubSqlite({ stdout = '', stderr = '', code = 0 } = {}) {
    let stdinData = '';
    mockExecFile.mockImplementation((file, args, opts, cb) => {
      const child = {
        stdin: { write: (d) => { stdinData += d; }, end: () => {} },
      };
      setImmediate(() => {
        const err = code === 0 ? null : Object.assign(new Error(`exit ${code}`), { code });
        cb(err, stdout, stderr);
      });
      return child;
    });
    return { stdin: () => stdinData };
  }

  it('runs the query read-only on the local Pi-hole DB with SQL on stdin', async () => {
    const stub = stubSqlite({ stdout: '4210\t192.168.1.229\n' });
    const r = await PROBES.pihole_dns_scalar({ sql: TOP_CLIENT_SQL });
    expect(r.value).toBe(4210);
    expect(r.context).toMatchObject({ value: 4210, label: '192.168.1.229', db_path: '/etc/pihole/pihole-FTL.db' });

    const [file, args] = mockExecFile.mock.calls[0];
    expect(file).toBe('sqlite3');
    expect(args).toEqual(['-readonly', '-separator', '\t', '/etc/pihole/pihole-FTL.db']);
    expect(stub.stdin()).toBe(TOP_CLIENT_SQL);   // SQL never reaches the command line
    expect(mockExec).not.toHaveBeenCalled();      // never touches the POS appliance
  });

  it('reports value 0 and no label when the window has no rows', async () => {
    stubSqlite({ stdout: '' });
    const r = await PROBES.pihole_dns_scalar({ sql: TOP_CLIENT_SQL });
    expect(r.value).toBe(0);
    expect(r.context.label).toBe('');
  });

  it('parses only the first row and tolerates a single-column result', async () => {
    stubSqlite({ stdout: '17\n99\n' });
    const r = await PROBES.pihole_dns_scalar({ sql: TOP_CLIENT_SQL });
    expect(r.value).toBe(17);
    expect(r.context.label).toBe('');
  });

  it('throws when sqlite3 exits non-zero (e.g. DB unreadable)', async () => {
    stubSqlite({ stderr: 'Error: unable to open database', code: 1 });
    await expect(PROBES.pihole_dns_scalar({ sql: TOP_CLIENT_SQL }))
      .rejects.toMatchObject({ code: 'OBSERVATION_INVALID' });
  });

  it('throws when the first column is not numeric', async () => {
    stubSqlite({ stdout: '192.168.1.229\t4210\n' });
    await expect(PROBES.pihole_dns_scalar({ sql: TOP_CLIENT_SQL }))
      .rejects.toMatchObject({ code: 'OBSERVATION_INVALID' });
  });

  it.each([
    ['no sql',              undefined],
    ['not a SELECT',        'PRAGMA table_info(queries)'],
    ['multiple statements', "SELECT 1; DELETE FROM queries"],
    ['a comment',           "SELECT 1 /* x */"],
    ['ATTACH',              "SELECT 1 WHERE ATTACH DATABASE 'x'"],
  ])('rejects %s without spawning sqlite3', async (_label, sql) => {
    await expect(PROBES.pihole_dns_scalar({ sql }))
      .rejects.toMatchObject({ code: 'OBSERVATION_INVALID' });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('throws when dns_monitor.pihole_db_path is not configured', async () => {
    mockDnsMonitorCfg.mockReturnValueOnce(undefined);
    await expect(PROBES.pihole_dns_scalar({ sql: TOP_CLIENT_SQL }))
      .rejects.toMatchObject({ code: 'OBSERVATION_INVALID' });
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

describe('config/observation-monitors.js — DNS visibility monitors', () => {
  const defs = require('../config/observation-monitors');
  const DNS_IDS = ['dns_client_query_flood', 'dns_client_domain_spread', 'dns_client_nxdomain_burst', 'dns_blocked_spike'];

  it.each(DNS_IDS)('%s exists, is wired to pihole_dns_scalar, and ships disabled until Pi-hole is deployed', (id) => {
    const def = defs.find(d => d.id === id);
    expect(def).toBeDefined();
    expect(def.enabled).toBe(false);
    expect(def.probe).toBe('pihole_dns_scalar');
    expect(def.threshold.medium).toBeLessThan(def.threshold.high);
    expect(def.report_template).toContain('{{label}}');
  });

  it.each(DNS_IDS)('%s SQL passes the probe validator and excludes the resolver host itself', async (id) => {
    const def = defs.find(d => d.id === id);
    mockExecFile.mockImplementation((f, a, o, cb) => { setImmediate(() => cb(null, '0\n', '')); return { stdin: { write() {}, end() {} } }; });
    await expect(PROBES.pihole_dns_scalar(def.params)).resolves.toMatchObject({ value: 0 });
    expect(def.params.sql).toContain("client NOT IN ('127.0.0.1', '::1')");
  });

  it('a residential-proxy-style client trips the flood monitor high', () => {
    const def = defs.find(d => d.id === 'dns_client_query_flood');
    expect(classify(200,  def.threshold)).toBe('none');
    expect(classify(6000, def.threshold)).toBe('high');
  });
});
