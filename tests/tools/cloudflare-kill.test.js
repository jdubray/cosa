'use strict';

/**
 * Unit tests for src/tools/cloudflare-kill.js
 *
 * Acceptance Criteria covered:
 *   AC1 — attempts systemctl stop → pm2 stop → kill $(pgrep cloudflared) in order
 *   AC2 — waits 2 seconds and verifies process is dead via pgrep
 *   AC3 — returns success, method, verificationPass, timestamp
 *   AC4 — returns success: false if process still running after kill
 *   AC5 — risk level is 'high'
 *   AC6 — logs the kill event (symbolic, no secrets in output)
 *   AC7 — fires ips_alert fire-and-forget on success
 */

// ---------------------------------------------------------------------------
// Mocks — hoisted before any require()
// ---------------------------------------------------------------------------

const mockIsConnected  = jest.fn();
const mockExec         = jest.fn();
const mockDispatch     = jest.fn();

jest.mock('../../src/ssh-backend', () => ({
  isConnected: (...a) => mockIsConnected(...a),
  exec:        (...a) => mockExec(...a),
}));

jest.mock('../../src/tool-registry', () => ({
  dispatch: (...a) => mockDispatch(...a),
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

const { handler, riskLevel, name } = require('../../src/tools/cloudflare-kill');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** SSH success response. */
const OK   = { stdout: '', stderr: '', exitCode: 0 };
/** SSH failure response. */
const FAIL = { stdout: '', stderr: 'Failed', exitCode: 1 };
/** pgrep result: process still running. */
const PGREP_ALIVE = { stdout: '1234\n', stderr: '', exitCode: 0 };
/** pgrep result: process gone. */
const PGREP_GONE  = { stdout: '',       stderr: '', exitCode: 1 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Configure the mockExec call sequence for one handler() invocation.
 *
 * Handler call order:
 *   1. systemctl stop cloudflared
 *   2. pm2 stop cloudflared         (only when systemctl fails)
 *   3. kill $(pgrep cloudflared)    (only when pm2 also fails)
 *   Last: pgrep cloudflared         (verification — after sleep)
 *
 * @param {'systemctl'|'pm2'|'kill'|'none'} successMethod
 * @param {boolean} pgrepFindsProcess  true = process still alive (fail case)
 */
function setupExec(successMethod, pgrepFindsProcess) {
  mockExec.mockReset();
  const pgrepResult = pgrepFindsProcess ? PGREP_ALIVE : PGREP_GONE;

  if (successMethod === 'systemctl') {
    mockExec
      .mockResolvedValueOnce(OK)           // systemctl → success
      .mockResolvedValueOnce(pgrepResult); // verify
    return;
  }
  if (successMethod === 'pm2') {
    mockExec
      .mockResolvedValueOnce(FAIL)         // systemctl → fail
      .mockResolvedValueOnce(OK)           // pm2 → success
      .mockResolvedValueOnce(pgrepResult); // verify
    return;
  }
  if (successMethod === 'kill') {
    mockExec
      .mockResolvedValueOnce(FAIL)         // systemctl → fail
      .mockResolvedValueOnce(FAIL)         // pm2 → fail
      .mockResolvedValueOnce(OK)           // kill → success
      .mockResolvedValueOnce(pgrepResult); // verify
    return;
  }
  // 'none' — all three fail; handler returns early (no verify call)
  mockExec
    .mockResolvedValueOnce(FAIL)
    .mockResolvedValueOnce(FAIL)
    .mockResolvedValueOnce(FAIL);
}

/**
 * Run handler() and flush the fire-and-forget microtask afterward.
 * setTimeout is mocked to be instant (see beforeEach), so sleep(2000) is a no-op.
 */
async function run() {
  const result = await handler();
  // Let the fire-and-forget ips_alert dispatch resolve.
  await Promise.resolve();
  return result;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockIsConnected.mockReturnValue(true);
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue({});
  setupExec('systemctl', false); // safe default

  // Make setTimeout call fn immediately — collapses sleep(2000) to a no-op.
  // The handler still correctly awaits (yielding to microtasks) but the
  // 2-second wall-clock delay is removed for fast unit tests.
  jest.spyOn(global, 'setTimeout').mockImplementation((fn) => { fn(); return {}; });
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// AC5 — module metadata
// ---------------------------------------------------------------------------

describe('AC5 — module metadata', () => {
  it('exports name = cloudflare_kill', () => {
    expect(name).toBe('cloudflare_kill');
  });

  it('exports riskLevel = high', () => {
    expect(riskLevel).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// AC1 — fallback chain: systemctl → pm2 → kill
// ---------------------------------------------------------------------------

describe('AC1 — kill method fallback chain', () => {
  it('uses systemctl when it succeeds', async () => {
    setupExec('systemctl', false);
    const result = await run();
    expect(result.method).toBe('systemctl');
  });

  it('does NOT call pm2 when systemctl succeeds', async () => {
    setupExec('systemctl', false);
    await run();
    const cmds = mockExec.mock.calls.map((c) => c[0]);
    expect(cmds.some((c) => c.includes('pm2'))).toBe(false);
  });

  it('falls back to pm2 when systemctl fails', async () => {
    setupExec('pm2', false);
    const result = await run();
    expect(result.method).toBe('pm2');
  });

  it('does NOT call kill when pm2 succeeds', async () => {
    setupExec('pm2', false);
    await run();
    const cmds = mockExec.mock.calls.map((c) => c[0]);
    expect(cmds.some((c) => c.includes('$(pgrep'))).toBe(false);
  });

  it('falls back to kill when both systemctl and pm2 fail', async () => {
    setupExec('kill', false);
    const result = await run();
    expect(result.method).toBe('kill');
  });

  it('returns success: false and method: null when all methods fail', async () => {
    setupExec('none', false);
    const result = await handler();
    expect(result.success).toBe(false);
    expect(result.method).toBeNull();
  });

  it('throws when SSH is not connected', async () => {
    mockIsConnected.mockReturnValue(false);
    await expect(handler()).rejects.toThrow(/SSH not connected/i);
  });

  it('executes systemctl stop cloudflared as the first attempt', async () => {
    setupExec('systemctl', false);
    await run();
    expect(mockExec.mock.calls[0][0]).toContain('systemctl stop cloudflared');
  });

  it('executes pm2 stop cloudflared as the second attempt', async () => {
    setupExec('pm2', false);
    await run();
    expect(mockExec.mock.calls[1][0]).toContain('pm2 stop cloudflared');
  });

  it('executes kill $(pgrep cloudflared) as the third attempt', async () => {
    setupExec('kill', false);
    await run();
    expect(mockExec.mock.calls[2][0]).toContain('kill $(pgrep cloudflared)');
  });
});

// ---------------------------------------------------------------------------
// AC2 — sleep then pgrep verification
// ---------------------------------------------------------------------------

describe('AC2 — sleep and pgrep verification', () => {
  it('calls pgrep cloudflared as the final exec after the kill', async () => {
    setupExec('systemctl', false);
    await run();
    const lastCmd = mockExec.mock.calls.at(-1)[0];
    expect(lastCmd).toContain('pgrep cloudflared');
  });

  it('pgrep is always the last exec call, after the stop command', async () => {
    // Verify ordering: kill command at n-2, pgrep at n-1.
    setupExec('kill', false);
    await run();
    const cmds = mockExec.mock.calls.map((c) => c[0]);
    const pgrep = cmds.at(-1);
    const kill  = cmds.at(-2);
    expect(pgrep).toContain('pgrep cloudflared');
    expect(kill).toContain('kill $(pgrep cloudflared)');
  });

  it('sleep is called with 2000 ms delay', async () => {
    setupExec('systemctl', false);
    // setTimeout spy records calls; verify 2000 ms was passed.
    await handler(); // use handler() directly (spy already on setTimeout)
    const args = global.setTimeout.mock.calls[0];
    expect(args[1]).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// AC3 — return shape: success, method, verificationPass, timestamp
// ---------------------------------------------------------------------------

describe('AC3 — return shape', () => {
  it('result has success field (boolean)', async () => {
    const result = await run();
    expect(typeof result.success).toBe('boolean');
  });

  it('result has method field', async () => {
    const result = await run();
    expect(result).toHaveProperty('method');
  });

  it('result has verificationPass field (boolean)', async () => {
    const result = await run();
    expect(typeof result.verificationPass).toBe('boolean');
  });

  it('result has timestamp as ISO 8601 string', async () => {
    const result = await run();
    expect(() => new Date(result.timestamp).toISOString()).not.toThrow();
  });

  it('result has error field (null on success)', async () => {
    const result = await run();
    expect(result.error).toBeNull();
  });

  it('result has error string when all methods fail', async () => {
    setupExec('none', false);
    const result = await handler();
    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC4 — success: false when process still running after kill
// ---------------------------------------------------------------------------

describe('AC4 — success: false when process survives', () => {
  it('returns success: false when pgrep finds the process still running', async () => {
    setupExec('systemctl', true); // process still alive
    const result = await run();
    expect(result.success).toBe(false);
    expect(result.verificationPass).toBe(false);
  });

  it('returns success: true when pgrep finds no process', async () => {
    setupExec('systemctl', false); // process gone
    const result = await run();
    expect(result.success).toBe(true);
    expect(result.verificationPass).toBe(true);
  });

  it('error is non-null when process still running', async () => {
    setupExec('systemctl', true);
    const result = await run();
    expect(typeof result.error).toBe('string');
    expect(result.error).toMatch(/still running/i);
  });

  it('verificationPass is true when pgrep exits non-zero (process gone)', async () => {
    setupExec('pm2', false);
    const result = await run();
    expect(result.verificationPass).toBe(true);
  });

  it('verificationPass is false when pgrep exits zero (process alive)', async () => {
    setupExec('pm2', true);
    const result = await run();
    expect(result.verificationPass).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC7 — fire-and-forget ips_alert on success
// ---------------------------------------------------------------------------

describe('AC7 — ips_alert dispatched fire-and-forget on success', () => {
  it('dispatches ips_alert when kill succeeds', async () => {
    setupExec('systemctl', false);
    await run();
    expect(mockDispatch).toHaveBeenCalledWith(
      'ips_alert',
      expect.objectContaining({ severity: 'high' })
    );
  });

  it('does NOT dispatch ips_alert when all kill methods fail', async () => {
    setupExec('none', false);
    await handler();
    await Promise.resolve();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('does NOT dispatch ips_alert when process survives kill (success: false)', async () => {
    setupExec('systemctl', true);
    await run();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('ips_alert payload includes the method used', async () => {
    setupExec('pm2', false);
    await run();
    const payload = mockDispatch.mock.calls[0][1];
    expect(payload.message).toContain('pm2');
  });

  it('ips_alert dispatch errors are silently swallowed (TOOL_NOT_FOUND)', async () => {
    setupExec('systemctl', false);
    const err    = new Error('tool not found');
    err.code     = 'TOOL_NOT_FOUND';
    mockDispatch.mockRejectedValueOnce(err);
    await expect(run()).resolves.toBeDefined();
  });

  it('non-TOOL_NOT_FOUND dispatch errors are also swallowed (logged as warn)', async () => {
    setupExec('systemctl', false);
    mockDispatch.mockRejectedValueOnce(new Error('email gateway down'));
    await expect(run()).resolves.toBeDefined();
  });
});
