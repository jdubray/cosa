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
