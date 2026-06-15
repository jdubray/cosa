'use strict';

// ---------------------------------------------------------------------------
// Unit tests for the action verifier (Verification Loop spec, Layer A).
// All collaborators are mocked so the re-probe control flow is isolated and the
// injectable clock keeps the suite instant (no real sleeping).
// ---------------------------------------------------------------------------

const mockDispatch = jest.fn();
jest.mock('../src/tool-registry', () => ({
  dispatch: (...a) => mockDispatch(...a),
}));

const mockGateCheck = jest.fn();
jest.mock('../src/security-gate', () => ({ check: (...a) => mockGateCheck(...a) }));

// Real resolveDotPath behaviour; resolveRisk is controllable per-test.
const mockResolveRisk = jest.fn();
jest.mock('../src/runbook-executor', () => ({
  resolveDotPath: (obj, p) =>
    String(p).split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj),
  resolveRisk: (...a) => mockResolveRisk(...a),
}));

jest.mock('../src/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

let mockVerificationCfg;
jest.mock('../config/cosa.config', () => ({
  getConfig: () => ({ appliance: { verification: mockVerificationCfg } }),
}));

const actionVerifier = require('../src/action-verifier');

/** A test clock: now() reads a counter; sleep(ms) advances it. No real time. */
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: (ms) => { t += ms; return Promise.resolve(); },
  };
}

function policy(overrides = {}) {
  return {
    tool: 'appliance_api_call',
    when: { endpoint_name: 'pause_store' },
    probe: {
      tool_name: 'health_check',
      check_field: 'overall_status',
      expect_value: 'healthy',
      settle_seconds: 0,
      max_attempts: 1,
      ...(overrides.probe ?? {}),
    },
    ...overrides.policy,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveRisk.mockReturnValue('read');
  mockGateCheck.mockResolvedValue({ blocked: false });
  mockVerificationCfg = { enabled: true, max_verify_seconds: 45, policies: [policy()] };
});

// ---------------------------------------------------------------------------
// matchPolicy (AC1)
// ---------------------------------------------------------------------------

describe('matchPolicy', () => {
  it('matches on tool name and all `when` fields', () => {
    const m = actionVerifier.matchPolicy('appliance_api_call', { endpoint_name: 'pause_store' });
    expect(m).not.toBeNull();
  });

  it('returns null when `when` does not match the input', () => {
    expect(actionVerifier.matchPolicy('appliance_api_call', { endpoint_name: 'update_order_status' })).toBeNull();
  });

  it('returns null when the tool name does not match', () => {
    expect(actionVerifier.matchPolicy('restart_appliance', {})).toBeNull();
  });

  it('returns null when verification is disabled', () => {
    mockVerificationCfg = { enabled: false, policies: [policy()] };
    expect(actionVerifier.matchPolicy('appliance_api_call', { endpoint_name: 'pause_store' })).toBeNull();
  });

  it('returns the first matching policy', () => {
    const first  = policy({ policy: { id: 'first' } });
    const second = policy({ policy: { id: 'second' } });
    mockVerificationCfg = { enabled: true, policies: [first, second] };
    const m = actionVerifier.matchPolicy('appliance_api_call', { endpoint_name: 'pause_store' });
    expect(m.id).toBe('first');
  });
});

// ---------------------------------------------------------------------------
// verify (AC2–AC8)
// ---------------------------------------------------------------------------

describe('verify', () => {
  const call = ['appliance_api_call', { endpoint_name: 'pause_store' }];

  it('AC8: returns null when no policy matches (no-op for caller)', async () => {
    const v = await actionVerifier.verify('appliance_api_call', { endpoint_name: 'nope' });
    expect(v).toBeNull();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('AC2: confirms on first attempt when the probe matches expect_value', async () => {
    mockDispatch.mockResolvedValue({ overall_status: 'healthy' });
    const v = await actionVerifier.verify(...call, fakeClock());
    expect(v).toMatchObject({ verified: true, status: 'confirmed', attempts: 1, observed: 'healthy' });
  });

  it('AC3: fails after max_attempts when the probe never matches', async () => {
    mockVerificationCfg.policies = [policy({ probe: { max_attempts: 3 } })];
    mockDispatch.mockResolvedValue({ overall_status: 'degraded' });
    const v = await actionVerifier.verify(...call, fakeClock());
    expect(v).toMatchObject({ verified: false, status: 'failed', attempts: 3, observed: 'degraded' });
  });

  it('AC4: confirms on attempt 2 of 3 and stops early', async () => {
    mockVerificationCfg.policies = [policy({ probe: { max_attempts: 3, settle_seconds: 1 } })];
    mockDispatch
      .mockResolvedValueOnce({ overall_status: 'degraded' })
      .mockResolvedValueOnce({ overall_status: 'healthy' });
    const v = await actionVerifier.verify(...call, fakeClock());
    expect(v).toMatchObject({ verified: true, status: 'confirmed', attempts: 2 });
    expect(mockDispatch).toHaveBeenCalledTimes(2);
  });

  it('AC5: skips a non-read probe (fails closed, attempts 0, no dispatch)', async () => {
    mockResolveRisk.mockReturnValue('high');
    const v = await actionVerifier.verify(...call, fakeClock());
    expect(v).toMatchObject({ status: 'inconclusive', attempts: 0 });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('AC6: honours expect_match (substring) instead of expect_value', async () => {
    mockVerificationCfg.policies = [policy({
      probe: { check_field: 'summary', expect_value: undefined, expect_match: 'within thresholds' },
    })];
    mockDispatch.mockResolvedValue({ summary: 'all processes within thresholds now' });
    const v = await actionVerifier.verify(...call, fakeClock());
    expect(v).toMatchObject({ verified: true, status: 'confirmed' });
  });

  it('AC7: respects max_verify_seconds (10 attempts × 30 s, 45 s ceiling → 2 attempts)', async () => {
    mockVerificationCfg = {
      enabled: true,
      max_verify_seconds: 45,
      policies: [policy({ probe: { max_attempts: 10, settle_seconds: 30 } })],
    };
    mockDispatch.mockResolvedValue({ overall_status: 'degraded' });
    const v = await actionVerifier.verify(...call, fakeClock());
    expect(v.attempts).toBe(2);
    expect(mockDispatch).toHaveBeenCalledTimes(2);
  });

  it('reports inconclusive when the probe throws (degrades, never throws out)', async () => {
    mockDispatch.mockRejectedValue(new Error('ssh down'));
    const v = await actionVerifier.verify(...call, fakeClock());
    expect(v.status).toBe('inconclusive');
    expect(String(v.observed)).toMatch(/probe error/);
  });

  it('reports inconclusive when the security gate blocks the probe', async () => {
    mockGateCheck.mockResolvedValue({ blocked: true, reason: 'nope' });
    const v = await actionVerifier.verify(...call, fakeClock());
    expect(v.status).toBe('inconclusive');
  });
});

// ---------------------------------------------------------------------------
// formatVerdict (AC12)
// ---------------------------------------------------------------------------

describe('formatVerdict', () => {
  it('renders a confirmed verdict as a single reassuring line', () => {
    const s = actionVerifier.formatVerdict({
      status: 'confirmed', probe: 'health_check', field: 'overall_status',
      attempts: 1, observed: 'healthy', expected: 'healthy',
    });
    expect(s).toContain('COSA VERIFICATION');
    expect(s).toContain('health_check.overall_status → healthy');
    expect(s).toContain('confirmed in 1 attempt');
    expect(s).not.toMatch(/do not report success/i);
  });

  it('renders a failed verdict with the imperative do-not-report-success line', () => {
    const s = actionVerifier.formatVerdict({
      status: 'failed', probe: 'health_check', field: 'overall_status',
      attempts: 3, observed: 'degraded', expected: 'healthy',
    });
    expect(s).toContain('NOT CONFIRMED');
    expect(s).toMatch(/do not report success/i);
  });

  it('labels an inconclusive verdict distinctly but still warns', () => {
    const s = actionVerifier.formatVerdict({
      status: 'inconclusive', probe: 'health_check', field: 'overall_status',
      attempts: 0, observed: null, expected: 'healthy',
    });
    expect(s).toContain('INCONCLUSIVE');
    expect(s).toMatch(/do not report success/i);
  });
});
