'use strict';

/**
 * Tirith Pre-Execution Scanner Integration Tests
 *
 * Tests the Tirith integration in src/security-gate.js:
 *   AC1 — initTirith() startup binary check
 *   AC2 — Tirith is invoked as step 1 of the check chain
 *   AC3 — Tirith threat response (blocked + reason + logged)
 *   AC4 — tirith.yaml config loading (mode, exceptions, defaults, parse errors)
 *   AC5 — Tirith exception list respected for db_query / bun_test
 *   AC6 — Graceful degradation when Tirith is absent or crashes
 *
 * Design notes
 * ─────────────
 * security-gate.js holds two module-level variables (`tirithAvailable` and
 * `tirithConfig`) that are mutated by initTirith().  To guarantee isolation,
 * every test calls jest.resetModules() in beforeEach and re-requires the
 * module inside each it() body so that each test starts from the default
 * state (tirithAvailable=false, tirithConfig defaults).
 *
 * All mock refs start with "mock" so they can be referenced inside
 * jest.mock() factory closures (Jest's hoisting TDZ exemption).
 */

// ---------------------------------------------------------------------------
// Mock function refs — names must start with "mock" for hoisting exemption
// ---------------------------------------------------------------------------

const mockExistsSync   = jest.fn();
const mockReadFileSync = jest.fn();
const mockExecFile     = jest.fn();
const mockYamlLoad     = jest.fn();
const mockLogWarn      = jest.fn();
const mockLogInfo      = jest.fn();
const mockGetConfig    = jest.fn();

// ---------------------------------------------------------------------------
// Mock registrations (hoisted above all require() calls by Jest)
// ---------------------------------------------------------------------------

jest.mock('fs', () => ({
  existsSync:   (...a) => mockExistsSync(...a),
  readFileSync: (...a) => mockReadFileSync(...a),
}));

jest.mock('child_process', () => ({
  execFile: (...a) => mockExecFile(...a),
}));

jest.mock('js-yaml', () => ({
  load: (...a) => mockYamlLoad(...a),
}));

jest.mock('../config/cosa.config', () => ({
  getConfig: () => mockGetConfig(),
}));

jest.mock('../src/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info:  mockLogInfo,
    warn:  mockLogWarn,
    error: jest.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

/** Config with zero dangerous-cmd patterns — Step 2 never blocks. */
function safeConfig() {
  return { appliance: { security: { dangerous_commands: [] } } };
}

/** Config that blocks a single known pattern. */
function patternConfig(pattern, reason) {
  return {
    appliance: {
      security: {
        dangerous_commands: [{ pattern, reason }],
      },
    },
  };
}

/**
 * Mock existsSync so the Tirith binary is "present" but the yaml file is not.
 * Relies on the binary path ending with 'tirith' (no extension) and the
 * config path ending with '.yaml'.
 */
function makeBinaryAvailable() {
  mockExistsSync.mockImplementation((p) => !String(p).endsWith('.yaml'));
}

/**
 * Mock existsSync so both binary and yaml config are "present", and stub
 * readFileSync + yaml.load to return `yamlParsed`.
 *
 * @param {object} yamlParsed - The object that yaml.load() should return.
 */
function makeBinaryAndConfigAvailable(yamlParsed) {
  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockReturnValue('# mock yaml content');
  mockYamlLoad.mockReturnValue(yamlParsed);
}

// ── execFile stubs ──────────────────────────────────────────────────────────

/** Stub: Tirith exits 0 — scan clean. */
function stubExitClean() {
  mockExecFile.mockImplementation((bin, args, opts, cb) => {
    setImmediate(() => cb(null, '', ''));
    return { stdin: { end: jest.fn() } };
  });
}

/** Stub: Tirith exits 1 — threat detected, reason in stdout JSON. */
function stubExitThreat(reason = 'Tirith threat detected') {
  mockExecFile.mockImplementation((bin, args, opts, cb) => {
    const err = Object.assign(new Error('threat'), { code: 1 });
    setImmediate(() => cb(err, JSON.stringify({ reason }), ''));
    return { stdin: { end: jest.fn() } };
  });
}

/** Stub: Tirith exits with a non-zero/non-one code (binary crash). */
function stubExitCrash(code = 2) {
  mockExecFile.mockImplementation((bin, args, opts, cb) => {
    const err = Object.assign(new Error('process crashed'), { code });
    setImmediate(() => cb(err, '', ''));
    return { stdin: { end: jest.fn() } };
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Fresh module registry — tirithAvailable resets to false, tirithConfig to defaults
  jest.resetModules();

  mockExistsSync.mockReset();
  mockReadFileSync.mockReset();
  mockExecFile.mockReset();
  mockYamlLoad.mockReset();
  mockLogWarn.mockReset();
  mockLogInfo.mockReset();
  mockGetConfig.mockReset();
  mockGetConfig.mockReturnValue(safeConfig());
});

// ---------------------------------------------------------------------------
// AC1 — initTirith() startup binary check
// ---------------------------------------------------------------------------

describe('AC1 — startup binary check', () => {
  it('logs a warning when the binary is absent and Tirith stays disabled', () => {
    mockExistsSync.mockReturnValue(false);
    const { initTirith } = require('../src/security-gate');

    initTirith();

    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining('falling back to dangerous-cmd detection only')
    );
  });

  it('does NOT invoke execFile on any check() call when binary is absent', async () => {
    mockExistsSync.mockReturnValue(false);
    const { initTirith, check } = require('../src/security-gate');

    initTirith();
    await check({ tool_name: 'ssh_exec', input: {} });

    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('logs a "ready" message when the binary is present', () => {
    makeBinaryAvailable();
    const { initTirith } = require('../src/security-gate');

    initTirith();

    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.stringContaining('ready')
    );
    expect(mockLogWarn).not.toHaveBeenCalledWith(
      expect.stringContaining('falling back')
    );
  });

  it('logs a defaults notice when binary is present but yaml is absent', () => {
    makeBinaryAvailable();
    const { initTirith } = require('../src/security-gate');

    initTirith();

    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.stringContaining('defaults')
    );
  });

  it('logs the loaded config summary when binary and yaml are both present', () => {
    makeBinaryAndConfigAvailable({ mode: 'block', exceptions: [] });
    const { initTirith } = require('../src/security-gate');

    initTirith();

    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.stringContaining('Tirith config loaded')
    );
  });
});

// ---------------------------------------------------------------------------
// AC2 — Tirith is invoked as step 1 of the check chain
// ---------------------------------------------------------------------------

describe('AC2 — Tirith is step 1 of the check chain', () => {
  it('calls execFile before consulting dangerous-cmd patterns', async () => {
    makeBinaryAvailable();
    const sg = require('../src/security-gate');
    sg.initTirith();

    const callOrder = [];
    mockExecFile.mockImplementation((bin, args, opts, cb) => {
      callOrder.push('tirith');
      setImmediate(() => cb(null, '', ''));
      return { stdin: { end: jest.fn() } };
    });
    mockGetConfig.mockImplementation(() => {
      callOrder.push('dangerous-cmd');
      return safeConfig();
    });

    await sg.check({ tool_name: 'ssh_exec', input: { command: 'ls' } });

    expect(callOrder[0]).toBe('tirith');
    expect(callOrder[1]).toBe('dangerous-cmd');
  });

  it('short-circuits and skips dangerous-cmd when Tirith blocks', async () => {
    makeBinaryAvailable();
    const sg = require('../src/security-gate');
    sg.initTirith();
    stubExitThreat('SQL injection probe');

    await sg.check({ tool_name: 'ssh_exec', input: { command: 'SELECT *' } });

    expect(mockGetConfig).not.toHaveBeenCalled();
  });

  it('proceeds to dangerous-cmd step when Tirith passes clean', async () => {
    makeBinaryAvailable();
    const sg = require('../src/security-gate');
    sg.initTirith();
    stubExitClean();

    await sg.check({ tool_name: 'ssh_exec', input: {} });

    expect(mockGetConfig).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC3 — Tirith threat response
// ---------------------------------------------------------------------------

describe('AC3 — Tirith threat detection', () => {
  it('returns { blocked: true } with reason from Tirith stdout', async () => {
    makeBinaryAvailable();
    const sg = require('../src/security-gate');
    sg.initTirith();
    stubExitThreat('credential harvesting attempt');

    const result = await sg.check({ tool_name: 'ssh_exec', input: {} });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('credential harvesting attempt');
  });

  it('uses default reason when Tirith stdout is not parseable JSON', async () => {
    makeBinaryAvailable();
    const sg = require('../src/security-gate');
    sg.initTirith();
    mockExecFile.mockImplementation((bin, args, opts, cb) => {
      const err = Object.assign(new Error('threat'), { code: 1 });
      setImmediate(() => cb(err, 'not-valid-json', ''));
      return { stdin: { end: jest.fn() } };
    });

    const result = await sg.check({ tool_name: 'ssh_exec', input: {} });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Tirith threat detected');
  });

  it('uses default reason when stdout JSON has no reason field', async () => {
    makeBinaryAvailable();
    const sg = require('../src/security-gate');
    sg.initTirith();
    mockExecFile.mockImplementation((bin, args, opts, cb) => {
      const err = Object.assign(new Error('threat'), { code: 1 });
      setImmediate(() => cb(err, JSON.stringify({ severity: 'high' }), ''));
      return { stdin: { end: jest.fn() } };
    });

    const result = await sg.check({ tool_name: 'ssh_exec', input: {} });

    expect(result.reason).toBe('Tirith threat detected');
  });

  it('logs a warning identifying the blocked tool and reason', async () => {
    makeBinaryAvailable();
    const sg = require('../src/security-gate');
    sg.initTirith();
    stubExitThreat('path traversal attempt');

    await sg.check({ tool_name: 'file_read', input: {} });

    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining('Tirith blocked tool call')
    );
  });
});

// ---------------------------------------------------------------------------
// AC4 — tirith.yaml config loading
// ---------------------------------------------------------------------------

describe('AC4 — tirith.yaml config loading', () => {
  it('defaults to mode=block and empty exceptions when yaml is absent', () => {
    makeBinaryAvailable();
    const { initTirith } = require('../src/security-gate');

    initTirith();

    // The "defaults" log line includes "mode=block"
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.stringContaining('mode=block')
    );
  });

  it('reads mode and exceptions from tirith.yaml when present', async () => {
    makeBinaryAndConfigAvailable({
      mode: 'block',
      exceptions: ['db_query', 'bun_test'],
    });
    const sg = require('../src/security-gate');
    sg.initTirith();
    stubExitClean();

    // db_query is in exceptions → execFile must NOT be called
    await sg.check({ tool_name: 'db_query', input: {} });
    expect(mockExecFile).not.toHaveBeenCalled();

    // ssh_exec is NOT in exceptions → execFile must be called
    await sg.check({ tool_name: 'ssh_exec', input: {} });
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('logs a warning and uses defaults when tirith.yaml is malformed', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('bad: [unclosed');
    mockYamlLoad.mockImplementation(() => { throw new Error('YAML parse error'); });

    const { initTirith } = require('../src/security-gate');
    initTirith();

    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining('Tirith config parse error')
    );
  });

  it('Tirith remains enabled after a config parse error', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('bad yaml');
    mockYamlLoad.mockImplementation(() => { throw new Error('parse error'); });

    const sg = require('../src/security-gate');
    sg.initTirith();
    stubExitClean();

    await sg.check({ tool_name: 'ssh_exec', input: {} });

    // Tirith was still invoked despite the config error
    expect(mockExecFile).toHaveBeenCalled();
  });

  it('ignores non-object yaml values (null, strings) without throwing', () => {
    makeBinaryAndConfigAvailable(null); // yaml.load returns null

    const { initTirith } = require('../src/security-gate');
    expect(() => initTirith()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC5 — Tirith exception list
// ---------------------------------------------------------------------------

describe('AC5 — Tirith exception list', () => {
  beforeEach(() => {
    makeBinaryAndConfigAvailable({
      mode:       'block',
      exceptions: ['db_query', 'bun_test'],
    });
    stubExitClean();
  });

  it('skips Tirith scan for db_query (in exceptions list)', async () => {
    const sg = require('../src/security-gate');
    sg.initTirith();

    await sg.check({ tool_name: 'db_query', input: {} });

    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('skips Tirith scan for bun_test (in exceptions list)', async () => {
    const sg = require('../src/security-gate');
    sg.initTirith();

    await sg.check({ tool_name: 'bun_test', input: {} });

    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('runs Tirith scan for tools NOT in the exceptions list', async () => {
    const sg = require('../src/security-gate');
    sg.initTirith();

    await sg.check({ tool_name: 'ssh_exec', input: {} });

    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('excepted tool still runs through dangerous-cmd check', async () => {
    const sg = require('../src/security-gate');
    sg.initTirith();
    mockGetConfig.mockReturnValue(patternConfig('rm\\s+-rf', 'Recursive delete'));

    const result = await sg.check({
      tool_name: 'db_query',
      input:     { command: 'rm -rf /' },
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Recursive delete');
  });
});

// ---------------------------------------------------------------------------
// AC6 — Graceful degradation
// ---------------------------------------------------------------------------

describe('AC6 — Graceful degradation when Tirith is unavailable or crashes', () => {
  it('check() works and returns { blocked: false } for safe input when binary is absent', async () => {
    mockExistsSync.mockReturnValue(false);
    const sg = require('../src/security-gate');
    sg.initTirith();

    const result = await sg.check({ tool_name: 'health_check', input: {} });

    expect(result).toEqual({ blocked: false });
  });

  it('dangerous-cmd patterns still block when Tirith is absent', async () => {
    mockExistsSync.mockReturnValue(false);
    const sg = require('../src/security-gate');
    sg.initTirith();
    mockGetConfig.mockReturnValue(patternConfig('rm\\s+-rf', 'Recursive delete'));

    const result = await sg.check({
      tool_name: 'ssh_exec',
      input:     { command: 'rm -rf /' },
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Recursive delete');
  });

  it('Tirith binary crash (exit code 2) is fail-open — returns { blocked: false }', async () => {
    makeBinaryAvailable();
    const sg = require('../src/security-gate');
    sg.initTirith();
    stubExitCrash(2);

    const result = await sg.check({ tool_name: 'ssh_exec', input: {} });

    expect(result.blocked).toBe(false);
  });

  it('logs a warning on Tirith invocation error', async () => {
    makeBinaryAvailable();
    const sg = require('../src/security-gate');
    sg.initTirith();
    stubExitCrash(2);

    await sg.check({ tool_name: 'ssh_exec', input: {} });

    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining('Tirith invocation error')
    );
  });

  it('Tirith timeout (null exit code) is also fail-open', async () => {
    makeBinaryAvailable();
    const sg = require('../src/security-gate');
    sg.initTirith();
    mockExecFile.mockImplementation((bin, args, opts, cb) => {
      const err = Object.assign(new Error('ETIMEDOUT'), { code: null });
      setImmediate(() => cb(err, '', ''));
      return { stdin: { end: jest.fn() } };
    });

    const result = await sg.check({ tool_name: 'ssh_exec', input: {} });

    expect(result.blocked).toBe(false);
  });

  it('does not throw even when Tirith crashes AND dangerous-cmd config is absent', async () => {
    makeBinaryAvailable();
    const sg = require('../src/security-gate');
    sg.initTirith();
    stubExitCrash(137); // SIGKILL
    mockGetConfig.mockReturnValue({ appliance: {} }); // no security section

    await expect(
      sg.check({ tool_name: 'ssh_exec', input: {} })
    ).resolves.toEqual({ blocked: false });
  });
});
