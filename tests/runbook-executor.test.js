'use strict';

// ---------------------------------------------------------------------------
// Mocks — isolate the executor's control flow.
// ---------------------------------------------------------------------------

const mockDispatch     = jest.fn();
const mockGetRiskLevel = jest.fn();
jest.mock('../src/tool-registry', () => ({
  dispatch:     (...a) => mockDispatch(...a),
  getRiskLevel: (...a) => mockGetRiskLevel(...a),
}));

const mockGet       = jest.fn();
const mockLogRun    = jest.fn(() => 42);
const mockUpdateRun = jest.fn();
const mockGetRun    = jest.fn(() => ({ iterations: 1 }));
jest.mock('../src/runbook-store', () => ({
  get:       (...a) => mockGet(...a),
  logRun:    (...a) => mockLogRun(...a),
  updateRun: (...a) => mockUpdateRun(...a),
  getRun:    (...a) => mockGetRun(...a),
}));

const mockGateCheck = jest.fn();
jest.mock('../src/security-gate', () => ({ check: (...a) => mockGateCheck(...a) }));

const mockSendEmail = jest.fn();
jest.mock('../src/email-gateway', () => ({ sendEmail: (...a) => mockSendEmail(...a) }));

const mockCreateAlert = jest.fn();
jest.mock('../src/session-store', () => ({ createAlert: (...a) => mockCreateAlert(...a) }));

jest.mock('../config/cosa.config', () => ({
  getConfig: () => ({ appliance: { name: 'TestPOS', operator: { email: 'ops@x.com' } } }),
}));

jest.mock('../src/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const { executeRunbook, resolveDotPath } = require('../src/runbook-executor');

/** Build a stored runbook row (steps/convergence serialised like the DB). */
function rb(overrides = {}) {
  return {
    name:           'rb1',
    steps:          JSON.stringify([{ tool_name: 'health_check', input: {} }]),
    convergence:    null,
    auto_approved:  0,
    max_iterations: 3,
    on_failure:     'alert',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRiskLevel.mockReturnValue('read');
  mockDispatch.mockResolvedValue({ ok: true });
  mockGetRun.mockReturnValue({ iterations: 1 });
  mockGateCheck.mockResolvedValue({ blocked: false });
});

// ---------------------------------------------------------------------------
// resolveDotPath
// ---------------------------------------------------------------------------

describe('resolveDotPath', () => {
  it('resolves nested paths and tolerates missing segments', () => {
    expect(resolveDotPath({ a: { b: 1 } }, 'a.b')).toBe(1);
    expect(resolveDotPath({ a: null }, 'a.b')).toBeUndefined();
    expect(resolveDotPath({}, 'x.y.z')).toBeUndefined();
    expect(resolveDotPath({ overall_status: 'healthy' }, 'overall_status')).toBe('healthy');
  });
});

// ---------------------------------------------------------------------------
// executeRunbook
// ---------------------------------------------------------------------------

describe('executeRunbook', () => {
  it('throws RUNBOOK_NOT_FOUND for an unknown runbook', async () => {
    mockGet.mockReturnValue(null);
    await expect(executeRunbook('nope', {})).rejects.toMatchObject({ code: 'RUNBOOK_NOT_FOUND' });
  });

  it('runs read-only steps once and succeeds when there is no convergence check', async () => {
    mockGet.mockReturnValue(rb());
    const result = await executeRunbook('rb1', { source: 'test' });
    expect(result.outcome).toBe('success');
    expect(result.converged).toBeNull();
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledWith('health_check', {});
  });

  it('succeeds when the convergence check passes', async () => {
    mockGet.mockReturnValue(rb({
      convergence: JSON.stringify({ tool_name: 'health_check', input: {}, check_field: 'overall_status', expect_value: 'healthy' }),
    }));
    mockDispatch
      .mockResolvedValueOnce({ ok: true })                  // step
      .mockResolvedValueOnce({ overall_status: 'healthy' }); // convergence
    const result = await executeRunbook('rb1', {});
    expect(result.outcome).toBe('success');
    expect(result.converged).toBe(true);
  });

  it('retries up to max_iterations then fails + alerts when never converging', async () => {
    mockGet.mockReturnValue(rb({
      max_iterations: 2,
      convergence: JSON.stringify({ tool_name: 'health_check', input: {}, check_field: 'overall_status', expect_value: 'healthy' }),
    }));
    mockDispatch.mockResolvedValue({ overall_status: 'degraded' }); // never healthy
    const result = await executeRunbook('rb1', {});
    expect(result.outcome).toBe('failed');
    expect(result.converged).toBe(false);
    // step+conv dispatched twice each = 4 calls
    expect(mockDispatch).toHaveBeenCalledTimes(4);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockCreateAlert).toHaveBeenCalledWith(expect.objectContaining({ category: 'runbook_failure' }));
  });

  it('aborts when a step throws and on_failure=abort', async () => {
    mockGet.mockReturnValue(rb({ on_failure: 'abort', steps: JSON.stringify([
      { tool_name: 'health_check', input: {} },
      { tool_name: 'db_query', input: {} },
    ]) }));
    mockDispatch
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('boom'));
    const result = await executeRunbook('rb1', {});
    expect(result.outcome).toBe('aborted');
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it('refuses to run a non-read step unless auto_approved (pre-flight abort)', async () => {
    mockGet.mockReturnValue(rb({ steps: JSON.stringify([{ tool_name: 'restart_appliance', input: {} }]) }));
    mockGetRiskLevel.mockImplementation(name => (name === 'restart_appliance' ? 'high' : 'read'));

    const result = await executeRunbook('rb1', {});
    expect(result.outcome).toBe('aborted');
    expect(mockDispatch).not.toHaveBeenCalled();          // nothing executed
    expect(mockCreateAlert).toHaveBeenCalledWith(expect.objectContaining({ category: 'runbook_failure' }));
  });

  it('runs a non-read step when the runbook is auto_approved', async () => {
    mockGet.mockReturnValue(rb({ auto_approved: 1, steps: JSON.stringify([{ tool_name: 'restart_appliance', input: { unit: 'pos' } }]) }));
    mockGetRiskLevel.mockReturnValue('high');
    const result = await executeRunbook('rb1', {});
    expect(result.outcome).toBe('success');
    expect(mockDispatch).toHaveBeenCalledWith('restart_appliance', { unit: 'pos' });
  });

  it('reports failed (not success) when a step throws with on_failure=alert and no convergence', async () => {
    // Regression for review M2: a thrown step must never collapse to success.
    mockGet.mockReturnValue(rb({ on_failure: 'alert', max_iterations: 2 }));
    mockDispatch.mockRejectedValue(new Error('boom'));

    const result = await executeRunbook('rb1', {});
    expect(result.outcome).toBe('failed');
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockCreateAlert).toHaveBeenCalledWith(expect.objectContaining({ category: 'runbook_failure' }));
  });

  it('runs each step through the security gate and aborts/fails on a block', async () => {
    // Regression for review C1: deterministic dispatch must not bypass the gate.
    mockGet.mockReturnValue(rb());
    mockGateCheck.mockResolvedValue({ blocked: true, reason: 'dangerous command', pattern: 'rm -rf' });

    const result = await executeRunbook('rb1', {});
    expect(result.outcome).toBe('failed');
    expect(mockDispatch).not.toHaveBeenCalled(); // gate blocked before dispatch
  });

  it('refuses a critical-risk step even when auto_approved (no ceiling bypass)', async () => {
    // Regression for review M3: critical may never run deterministically.
    mockGet.mockReturnValue(rb({ auto_approved: 1, steps: JSON.stringify([{ tool_name: 'pause_appliance', input: {} }]) }));
    mockGetRiskLevel.mockReturnValue('critical');

    const result = await executeRunbook('rb1', {});
    expect(result.outcome).toBe('aborted');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('refuses a non-read convergence tool (convergence must be read-only)', async () => {
    // Regression for review M3: convergence tool was previously unchecked.
    mockGet.mockReturnValue(rb({
      auto_approved: 1,
      convergence: JSON.stringify({ tool_name: 'restart_appliance', input: {}, check_field: 'x', expect_value: 1 }),
    }));
    mockGetRiskLevel.mockImplementation(name => (name === 'restart_appliance' ? 'high' : 'read'));

    const result = await executeRunbook('rb1', {});
    expect(result.outcome).toBe('aborted');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('treats a convergence-check throw as not converged', async () => {
    mockGet.mockReturnValue(rb({
      max_iterations: 1,
      convergence: JSON.stringify({ tool_name: 'health_check', input: {}, check_field: 'x', expect_value: 1 }),
    }));
    mockDispatch
      .mockResolvedValueOnce({ ok: true })          // step
      .mockRejectedValueOnce(new Error('probe down')); // convergence throws
    const result = await executeRunbook('rb1', {});
    expect(result.outcome).toBe('failed');
    expect(result.converged).toBe(false);
  });
});
