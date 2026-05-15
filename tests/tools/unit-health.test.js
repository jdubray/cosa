'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockExec      = jest.fn();
const mockGetConfig = jest.fn();

jest.mock('../../src/ssh-backend', () => ({
  exec: (...a) => mockExec(...a),
}));

jest.mock('../../config/cosa.config', () => ({
  getConfig: (...a) => mockGetConfig(...a),
}));

const { handler, _internal } = require('../../src/tools/unit-health');
const { buildScript, parseOutput, DEFAULT_UNITS } = _internal;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALL_ACTIVE_STDOUT =
  'baanbaan=active\n' +
  'baanbaan-ocr=active\n' +
  'marketing-engine=active\n' +
  'cloudflared=active\n';

const ONE_FAILED_STDOUT =
  'baanbaan=active\n' +
  'baanbaan-ocr=failed\n' +
  'marketing-engine=active\n' +
  'cloudflared=active\n';

function configWithDefaults() {
  return { appliance: { tools: { unit_health: { enabled: true } } } };
}

function configWithCustomUnits(units) {
  return { appliance: { tools: { unit_health: { enabled: true, units } } } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('unit_health tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('reports overall_status=healthy when every unit is active', async () => {
    mockGetConfig.mockReturnValue(configWithDefaults());
    mockExec.mockResolvedValue({ stdout: ALL_ACTIVE_STDOUT, stderr: '', exitCode: 0 });

    const result = await handler();

    expect(result.success).toBe(true);
    expect(result.overall_status).toBe('healthy');
    expect(result.units).toHaveLength(4);
    expect(result.units.every((u) => u.active)).toBe(true);
  });

  test('reports overall_status=degraded when at least one unit is not active', async () => {
    mockGetConfig.mockReturnValue(configWithDefaults());
    mockExec.mockResolvedValue({ stdout: ONE_FAILED_STDOUT, stderr: '', exitCode: 0 });

    const result = await handler();

    expect(result.overall_status).toBe('degraded');
    const failed = result.units.find((u) => u.unit === 'baanbaan-ocr');
    expect(failed).toEqual({ unit: 'baanbaan-ocr', state: 'failed', active: false });
  });

  test('uses configured units list when present', async () => {
    mockGetConfig.mockReturnValue(configWithCustomUnits(['custom-unit']));
    mockExec.mockResolvedValue({ stdout: 'custom-unit=active\n', stderr: '', exitCode: 0 });

    const result = await handler();

    expect(result.units).toEqual([{ unit: 'custom-unit', state: 'active', active: true }]);
    const [, script] = mockExec.mock.calls[0];
    expect(script).toContain("'custom-unit'");
    expect(script).not.toContain('baanbaan');
  });

  test('falls back to DEFAULT_UNITS when units list is empty or absent', async () => {
    mockGetConfig.mockReturnValue(configWithCustomUnits([]));
    mockExec.mockResolvedValue({ stdout: ALL_ACTIVE_STDOUT, stderr: '', exitCode: 0 });

    const result = await handler();

    expect(result.units.map((u) => u.unit)).toEqual(DEFAULT_UNITS);
  });

  test('returns overall_status=unreachable when ssh throws', async () => {
    mockGetConfig.mockReturnValue(configWithDefaults());
    mockExec.mockRejectedValue(new Error('connection refused'));

    const result = await handler();

    expect(result.success).toBe(false);
    expect(result.overall_status).toBe('unreachable');
    expect(result.error).toContain('connection refused');
    expect(result.units.every((u) => !u.active)).toBe(true);
  });

  test('returns overall_status=unreachable on non-zero exit', async () => {
    mockGetConfig.mockReturnValue(configWithDefaults());
    mockExec.mockResolvedValue({ stdout: '', stderr: 'bash: line 1: foo', exitCode: 2 });

    const result = await handler();

    expect(result.success).toBe(false);
    expect(result.overall_status).toBe('unreachable');
  });

  test('marks unit as unknown when stdout omits its line', async () => {
    mockGetConfig.mockReturnValue(configWithDefaults());
    // baanbaan-ocr omitted from output entirely
    mockExec.mockResolvedValue({
      stdout: 'baanbaan=active\nmarketing-engine=active\ncloudflared=active\n',
      stderr: '',
      exitCode: 0,
    });

    const result = await handler();

    const ocr = result.units.find((u) => u.unit === 'baanbaan-ocr');
    expect(ocr).toEqual({ unit: 'baanbaan-ocr', state: 'unknown', active: false });
    expect(result.overall_status).toBe('degraded');
  });
});

describe('unit_health buildScript', () => {
  test('emits one is-active line per unit, single-quoted, with fallback', () => {
    const script = buildScript(['a', 'b']);
    expect(script).toContain("systemctl is-active 'a'");
    expect(script).toContain("systemctl is-active 'b'");
    expect(script).toContain('|| echo unknown');
  });

  test('escapes embedded single quotes safely', () => {
    const script = buildScript(["weird'name"]);
    expect(script).toContain("'weird'\\''name'");
  });
});

describe('unit_health parseOutput', () => {
  test('preserves the configured unit order regardless of stdout order', () => {
    const out = 'b=active\na=inactive\n';
    const result = parseOutput(out, ['a', 'b']);
    expect(result).toEqual([
      { unit: 'a', state: 'inactive' },
      { unit: 'b', state: 'active' },
    ]);
  });

  test('marks units missing from stdout as unknown', () => {
    const result = parseOutput('a=active\n', ['a', 'b']);
    expect(result).toEqual([
      { unit: 'a', state: 'active' },
      { unit: 'b', state: 'unknown' },
    ]);
  });
});
