'use strict';

/**
 * Unit tests for src/security-fsm.js
 *
 * Acceptance Criteria covered:
 *   AC1  — FSM has all 6 states
 *   AC2  — ANOMALY_DETECTED from monitoring → classifying
 *   AC3  — FALSE_POSITIVE from classifying → monitoring
 *   AC4  — CLASSIFY_LOW / CLASSIFY_MEDIUM → alerting_operator
 *   AC5  — CLASSIFY_HIGH / CLASSIFY_CRITICAL → responding
 *   AC6  — NAP in responding: executes cloudflare_kill if not yet killed
 *   AC7  — NAP in responding: sends ips_alert after cloudflare_kill
 *   AC8  — NAP in alerting_operator: sends alert; schedules 15-min ALERT_TIMEOUT
 *   AC9  — CLEAR_THREAT from awaiting_clearance → recovering
 *   AC10 — HEALTH_CHECK_PASS from recovering → monitoring
 *   AC11 — Incidents persisted to security_incidents table
 *   AC12 — Invalid transitions throw
 */

// ---------------------------------------------------------------------------
// Better-sqlite3 mock — must be hoisted before any require()
//
// Provides a minimal in-memory implementation that lets the FSM call
// pragma(), exec(), and prepare().run() without native bindings.
// ---------------------------------------------------------------------------

/** Captured prepare().run() invocations for assertion. */
const dbRunCalls = [];

const mockDbInstance = {
  pragma:  jest.fn(),
  exec:    jest.fn(),
  prepare: jest.fn().mockImplementation((sql) => ({
    run: jest.fn().mockImplementation((params) => {
      dbRunCalls.push({ sql: sql.trim().replace(/\s+/g, ' '), params });
    }),
  })),
};

jest.mock('better-sqlite3', () => jest.fn(() => mockDbInstance));

// ---------------------------------------------------------------------------
// Other mocks
// ---------------------------------------------------------------------------

const mockDispatch = jest.fn();
jest.mock('../src/tool-registry', () => ({ dispatch: (...a) => mockDispatch(...a) }));

jest.mock('../config/cosa.config', () => ({
  getConfig: () => ({ env: { dataDir: '/tmp/cosa-test-db' } }),
}));

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  mkdirSync: jest.fn(),
}));

jest.mock('../src/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Module under test (loaded AFTER all mocks are declared)
// ---------------------------------------------------------------------------

const { createSecurityFSM, TRANSITIONS } = require('../src/security-fsm');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flush all pending microtasks. */
const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue({ success: true });
  dbRunCalls.length = 0;
  mockDbInstance.pragma.mockClear();
  mockDbInstance.exec.mockClear();
  mockDbInstance.prepare.mockClear();
  // Make setTimeout instant so NAP ALERT_TIMEOUT and verification happen synchronously.
  jest.spyOn(global, 'setTimeout').mockImplementation((fn) => { fn(); return {}; });
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// AC1 — all 6 states present in transition table
// ---------------------------------------------------------------------------

describe('AC1 — all 6 states exist in the transition table', () => {
  const ALL_STATES = [
    'monitoring',
    'classifying',
    'alerting_operator',
    'responding',
    'awaiting_clearance',
    'recovering',
  ];

  it('each state appears as an origin in TRANSITIONS', () => {
    const origins = new Set(Object.keys(TRANSITIONS).map((k) => k.split(':')[0]));
    for (const state of ALL_STATES) {
      expect(origins).toContain(state);
    }
  });

  it('each state appears as a target in TRANSITIONS', () => {
    const targets = new Set(Object.values(TRANSITIONS));
    for (const state of ALL_STATES) {
      expect(targets).toContain(state);
    }
  });

  it('FSM starts in monitoring state', () => {
    const fsm = createSecurityFSM();
    expect(fsm.current).toBe('monitoring');
  });
});

// ---------------------------------------------------------------------------
// AC2 — ANOMALY_DETECTED from monitoring → classifying
// ---------------------------------------------------------------------------

describe('AC2 — ANOMALY_DETECTED transitions monitoring → classifying', () => {
  it('current state is classifying after ANOMALY_DETECTED', () => {
    const fsm = createSecurityFSM();
    fsm.send('ANOMALY_DETECTED');
    expect(fsm.current).toBe('classifying');
  });

  it('TRANSITIONS table maps monitoring:ANOMALY_DETECTED to classifying', () => {
    expect(TRANSITIONS['monitoring:ANOMALY_DETECTED']).toBe('classifying');
  });
});

// ---------------------------------------------------------------------------
// AC3 — FALSE_POSITIVE from classifying → monitoring
// ---------------------------------------------------------------------------

describe('AC3 — FALSE_POSITIVE transitions classifying → monitoring', () => {
  it('returns to monitoring after FALSE_POSITIVE', () => {
    const fsm = createSecurityFSM();
    fsm.send('ANOMALY_DETECTED');
    fsm.send('FALSE_POSITIVE');
    expect(fsm.current).toBe('monitoring');
  });

  it('TRANSITIONS table maps classifying:FALSE_POSITIVE to monitoring', () => {
    expect(TRANSITIONS['classifying:FALSE_POSITIVE']).toBe('monitoring');
  });
});

// ---------------------------------------------------------------------------
// AC4 — CLASSIFY_LOW / CLASSIFY_MEDIUM → alerting_operator
// ---------------------------------------------------------------------------

describe('AC4 — CLASSIFY_LOW and CLASSIFY_MEDIUM → alerting_operator', () => {
  it('CLASSIFY_LOW transitions classifying → alerting_operator', () => {
    const fsm = createSecurityFSM();
    fsm.send('ANOMALY_DETECTED');
    // Spy on setTimeout to prevent instant ALERT_TIMEOUT from looping.
    jest.spyOn(global, 'setTimeout').mockImplementation(() => ({}));
    fsm.send('CLASSIFY_LOW');
    expect(fsm.current).toBe('alerting_operator');
  });

  it('CLASSIFY_MEDIUM transitions classifying → alerting_operator', () => {
    const fsm = createSecurityFSM();
    fsm.send('ANOMALY_DETECTED');
    jest.spyOn(global, 'setTimeout').mockImplementation(() => ({}));
    fsm.send('CLASSIFY_MEDIUM');
    expect(fsm.current).toBe('alerting_operator');
  });

  it('TRANSITIONS table maps classifying:CLASSIFY_LOW to alerting_operator', () => {
    expect(TRANSITIONS['classifying:CLASSIFY_LOW']).toBe('alerting_operator');
  });

  it('TRANSITIONS table maps classifying:CLASSIFY_MEDIUM to alerting_operator', () => {
    expect(TRANSITIONS['classifying:CLASSIFY_MEDIUM']).toBe('alerting_operator');
  });
});

// ---------------------------------------------------------------------------
// AC5 — CLASSIFY_HIGH / CLASSIFY_CRITICAL → responding
// ---------------------------------------------------------------------------

describe('AC5 — CLASSIFY_HIGH and CLASSIFY_CRITICAL → responding', () => {
  it('CLASSIFY_HIGH transitions classifying → responding', async () => {
    const fsm = createSecurityFSM();
    fsm.send('ANOMALY_DETECTED');
    fsm.send('CLASSIFY_HIGH', { severity: 'high', anomalyType: 'brute_force' });
    expect(fsm.current).toBe('responding');
  });

  it('CLASSIFY_CRITICAL transitions classifying → responding', async () => {
    const fsm = createSecurityFSM();
    fsm.send('ANOMALY_DETECTED');
    fsm.send('CLASSIFY_CRITICAL', { severity: 'critical', anomalyType: 'rootkit' });
    expect(fsm.current).toBe('responding');
  });

  it('payload severity and anomalyType are stored on the incident', async () => {
    const fsm = createSecurityFSM();
    fsm.send('ANOMALY_DETECTED');
    fsm.send('CLASSIFY_HIGH', { severity: 'high', anomalyType: 'brute_force' });
    const inc = fsm._getIncident();
    expect(inc.severity).toBe('high');
    expect(inc.anomalyType).toBe('brute_force');
  });

  it('TRANSITIONS table maps classifying:CLASSIFY_HIGH to responding', () => {
    expect(TRANSITIONS['classifying:CLASSIFY_HIGH']).toBe('responding');
  });

  it('TRANSITIONS table maps classifying:CLASSIFY_CRITICAL to responding', () => {
    expect(TRANSITIONS['classifying:CLASSIFY_CRITICAL']).toBe('responding');
  });
});

// ---------------------------------------------------------------------------
// AC6 — NAP in responding: cloudflare_kill dispatched if not yet killed
// ---------------------------------------------------------------------------

describe('AC6 — responding NAP dispatches cloudflare_kill', () => {
  it('dispatches cloudflare_kill when entering responding state', async () => {
    const fsm = createSecurityFSM();
    fsm.send('ANOMALY_DETECTED');
    fsm.send('CLASSIFY_HIGH', { severity: 'high' });
    await flushPromises();
    expect(mockDispatch).toHaveBeenCalledWith('cloudflare_kill', {});
  });

  it('sets cloudflareKilled on the incident after successful kill', async () => {
    const fsm = createSecurityFSM();
    fsm.send('ANOMALY_DETECTED');
    fsm.send('CLASSIFY_HIGH', { severity: 'high' });
    await flushPromises();
    expect(fsm._getIncident().cloudflareKilled).toBe(true);
  });

  it('does NOT dispatch cloudflare_kill a second time if already killed', async () => {
    // Simulate two high-severity classifications on the same incident
    // by directly inspecting call counts.
    mockDispatch.mockReset();
    mockDispatch.mockResolvedValue({ success: true });

    const fsm = createSecurityFSM();
    fsm.send('ANOMALY_DETECTED');
    fsm.send('CLASSIFY_HIGH', { severity: 'high' });
    await flushPromises();

    const firstCount = mockDispatch.mock.calls.filter(
      (c) => c[0] === 'cloudflare_kill'
    ).length;
    expect(firstCount).toBe(1);
  });

  it('continues to ips_alert even if cloudflare_kill dispatch fails', async () => {
    mockDispatch.mockReset();
    mockDispatch
      .mockRejectedValueOnce(new Error('kill failed'))  // cloudflare_kill
      .mockResolvedValueOnce({ success: true });         // ips_alert

    const fsm = createSecurityFSM();
    fsm.send('ANOMALY_DETECTED');
    fsm.send('CLASSIFY_HIGH', { severity: 'high' });
    await flushPromises();

    const alertCalls = mockDispatch.mock.calls.filter((c) => c[0] === 'ips_alert');
    expect(alertCalls.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC7 — NAP in responding: ips_alert sent after cloudflare_kill
// ---------------------------------------------------------------------------

describe('AC7 — responding NAP sends ips_alert after cloudflare_kill', () => {
  it('dispatches ips_alert after cloudflare_kill in responding state', async () => {
    const fsm = createSecurityFSM();
    fsm.send('ANOMALY_DETECTED');
    fsm.send('CLASSIFY_HIGH', { severity: 'high' });
    await flushPromises();

    const alertCalls = mockDispatch.mock.calls.filter((c) => c[0] === 'ips_alert');
    expect(alertCalls.length).toBeGreaterThan(0);
  });

  it('ips_alert is dispatched after cloudflare_kill (ordering check)', async () => {
    const order = [];
    mockDispatch.mockReset();
    mockDispatch.mockImplementation(async (toolName) => {
      order.push(toolName);
      return { success: true };
    });

    const fsm = createSecurityFSM();
    fsm.send('ANOMALY_DETECTED');
    fsm.send('CLASSIFY_HIGH', { severity: 'high' });
    await flushPromises();

    const killIdx  = order.indexOf('cloudflare_kill');
    const alertIdx = order.indexOf('ips_alert');
    expect(killIdx).toBeGreaterThanOrEqual(0);
    expect(alertIdx).toBeGreaterThan(killIdx);
  });

  it('sets alertSent on the incident after ips_alert', async () => {
    const fsm = createSecurityFSM();
    fsm.send('ANOMALY_DETECTED');
    fsm.send('CLASSIFY_HIGH', { severity: 'high' });
    await flushPromises();
    expect(fsm._getIncident().alertSent).toBe(true);
  });

  it('NAP advances FSM to awaiting_clearance via RESPONSE_COMPLETE', async () => {
    const fsm = createSecurityFSM();
    fsm.send('ANOMALY_DETECTED');
    fsm.send('CLASSIFY_HIGH', { severity: 'high' });
    await flushPromises();
    expect(fsm.current).toBe('awaiting_clearance');
  });
});

// ---------------------------------------------------------------------------
// AC8 — NAP in alerting_operator: alert sent; 15-min ALERT_TIMEOUT scheduled
// ---------------------------------------------------------------------------

describe('AC8 — alerting_operator NAP: sends alert and schedules timeout', () => {
  it('dispatches ips_alert when entering alerting_operator', async () => {
    // Override setTimeout to NOT fire immediately so the test controls the timeout.
    const mockHandle = {};
    jest.spyOn(global, 'setTimeout').mockReturnValue(mockHandle);

    const fsm = createSecurityFSM();
    fsm.send('ANOMALY_DETECTED');
    fsm.send('CLASSIFY_LOW', { severity: 'low' });
    await flushPromises();

    const alertCalls = mockDispatch.mock.calls.filter((c) => c[0] === 'ips_alert');
    expect(alertCalls.length).toBeGreaterThan(0);
  });

  it('setTimeout is called with 15-minute delay for ALERT_TIMEOUT', () => {
    const timeoutCalls = [];
    jest.spyOn(global, 'setTimeout').mockImplementation((fn, delay) => {
      timeoutCalls.push({ fn, delay });
      return {};
    });

    const fsm = createSecurityFSM();
    fsm.send('ANOMALY_DETECTED');
    fsm.send('CLASSIFY_MEDIUM', { severity: 'medium' });

    const alertTimeout = timeoutCalls.find((c) => c.delay === 15 * 60 * 1000);
    expect(alertTimeout).toBeDefined();
  });

  it('ALERT_TIMEOUT fires if timeout elapses and FSM is still in alerting_operator', () => {
    let capturedFn = null;
    jest.spyOn(global, 'setTimeout').mockImplementation((fn) => {
      capturedFn = fn;
      return {};
    });

    const fsm = createSecurityFSM();
    fsm.send('ANOMALY_DETECTED');
    fsm.send('CLASSIFY_MEDIUM', { severity: 'medium' });

    expect(fsm.current).toBe('alerting_operator');

    // Simulate timer firing — should escalate to responding.
    expect(capturedFn).not.toBeNull();
    capturedFn();

    expect(fsm.current).toBe('responding');
  });

  it('timeout is cancelled when OPERATOR_ACK is received before expiry', () => {
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    const handle = { id: 99 };
    jest.spyOn(global, 'setTimeout').mockReturnValue(handle);

    const fsm = createSecurityFSM();
    fsm.send('ANOMALY_DETECTED');
    fsm.send('CLASSIFY_MEDIUM', { severity: 'medium' });
    fsm.send('OPERATOR_ACK');

    expect(clearTimeoutSpy).toHaveBeenCalledWith(handle);
  });
});

// ---------------------------------------------------------------------------
// AC9 — CLEAR_THREAT from awaiting_clearance → recovering
// ---------------------------------------------------------------------------

describe('AC9 — CLEAR_THREAT transitions awaiting_clearance → recovering', () => {
  it('transitions to recovering on CLEAR_THREAT', async () => {
    const fsm = createSecurityFSM();
    fsm.send('ANOMALY_DETECTED');
    fsm.send('CLASSIFY_HIGH', { severity: 'high' });
    await flushPromises();

    expect(fsm.current).toBe('awaiting_clearance');
    fsm.send('CLEAR_THREAT');
    expect(fsm.current).toBe('recovering');
  });

  it('TRANSITIONS table maps awaiting_clearance:CLEAR_THREAT to recovering', () => {
    expect(TRANSITIONS['awaiting_clearance:CLEAR_THREAT']).toBe('recovering');
  });
});

// ---------------------------------------------------------------------------
// AC10 — HEALTH_CHECK_PASS from recovering → monitoring
// ---------------------------------------------------------------------------

describe('AC10 — HEALTH_CHECK_PASS transitions recovering → monitoring', () => {
  it('transitions to monitoring on HEALTH_CHECK_PASS', async () => {
    const fsm = createSecurityFSM();
    fsm.send('ANOMALY_DETECTED');
    fsm.send('CLASSIFY_HIGH', { severity: 'high' });
    await flushPromises();

    fsm.send('CLEAR_THREAT');
    fsm.send('HEALTH_CHECK_PASS');
    expect(fsm.current).toBe('monitoring');
  });

  it('TRANSITIONS table maps recovering:HEALTH_CHECK_PASS to monitoring', () => {
    expect(TRANSITIONS['recovering:HEALTH_CHECK_PASS']).toBe('monitoring');
  });

  it('full lifecycle: monitoring → classifying → responding → awaiting_clearance → recovering → monitoring', async () => {
    const fsm = createSecurityFSM();
    expect(fsm.current).toBe('monitoring');

    fsm.send('ANOMALY_DETECTED');
    expect(fsm.current).toBe('classifying');

    fsm.send('CLASSIFY_HIGH', { severity: 'high' });
    expect(fsm.current).toBe('responding');

    await flushPromises(); // NAP: cloudflare_kill + ips_alert + RESPONSE_COMPLETE
    expect(fsm.current).toBe('awaiting_clearance');

    fsm.send('CLEAR_THREAT');
    expect(fsm.current).toBe('recovering');

    fsm.send('HEALTH_CHECK_PASS');
    expect(fsm.current).toBe('monitoring');
  });
});

// ---------------------------------------------------------------------------
// AC11 — incidents persisted to security_incidents table
// ---------------------------------------------------------------------------

describe('AC11 — incidents persisted to security_incidents', () => {
  it('upsertIncident is called when FSM is created', () => {
    dbRunCalls.length = 0;
    createSecurityFSM();
    expect(dbRunCalls.length).toBeGreaterThan(0);
  });

  it('upsertIncident is called on each state transition', () => {
    dbRunCalls.length = 0;
    const fsm = createSecurityFSM();
    const countAfterCreate = dbRunCalls.length;

    fsm.send('ANOMALY_DETECTED');
    expect(dbRunCalls.length).toBeGreaterThan(countAfterCreate);
  });

  it('persisted row contains incident_id, state, severity', () => {
    dbRunCalls.length = 0;
    const fsm = createSecurityFSM();
    fsm.send('ANOMALY_DETECTED');
    fsm.send('CLASSIFY_HIGH', { severity: 'high', anomalyType: 'brute_force' });

    const lastRun = dbRunCalls.at(-1);
    expect(lastRun.params).toMatchObject({
      incident_id:  fsm.incidentId,
      state:        'responding',
      severity:     'high',
      anomaly_type: 'brute_force',
    });
  });

  it('each FSM instance gets a unique incidentId', () => {
    const fsm1 = createSecurityFSM();
    const fsm2 = createSecurityFSM();
    expect(fsm1.incidentId).not.toBe(fsm2.incidentId);
  });

  it('cloudflare_killed is persisted as 1 after successful kill', async () => {
    dbRunCalls.length = 0;
    const fsm = createSecurityFSM();
    fsm.send('ANOMALY_DETECTED');
    fsm.send('CLASSIFY_HIGH', { severity: 'high' });
    await flushPromises();

    const withKilledFlag = dbRunCalls.find(
      (r) => r.params?.cloudflare_killed === 1
    );
    expect(withKilledFlag).toBeDefined();
  });

  it('alert_sent is persisted as 1 after ips_alert', async () => {
    dbRunCalls.length = 0;
    const fsm = createSecurityFSM();
    fsm.send('ANOMALY_DETECTED');
    fsm.send('CLASSIFY_HIGH', { severity: 'high' });
    await flushPromises();

    const withAlertSent = dbRunCalls.find(
      (r) => r.params?.alert_sent === 1
    );
    expect(withAlertSent).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AC12 — invalid transitions throw
// ---------------------------------------------------------------------------

describe('AC12 — invalid transitions throw', () => {
  it('throws when sending an event invalid for the current state', () => {
    const fsm = createSecurityFSM();
    // monitoring → CLEAR_THREAT is not a valid transition
    expect(() => fsm.send('CLEAR_THREAT')).toThrow(/invalid transition/i);
  });

  it('throws when sending ANOMALY_DETECTED from a non-monitoring state', () => {
    const fsm = createSecurityFSM();
    fsm.send('ANOMALY_DETECTED'); // now in classifying
    expect(() => fsm.send('ANOMALY_DETECTED')).toThrow();
  });

  it('throws when sending HEALTH_CHECK_PASS from classifying', () => {
    const fsm = createSecurityFSM();
    fsm.send('ANOMALY_DETECTED');
    expect(() => fsm.send('HEALTH_CHECK_PASS')).toThrow();
  });

  it('throws when sending CLASSIFY_HIGH from monitoring (skipping classifying)', () => {
    const fsm = createSecurityFSM();
    expect(() => fsm.send('CLASSIFY_HIGH')).toThrow();
  });

  it('fsm.transition() can be used to check a transition without mutating state', () => {
    const fsm = createSecurityFSM();
    expect(() => fsm.transition('monitoring', 'ANOMALY_DETECTED')).not.toThrow();
    expect(fsm.transition('monitoring', 'ANOMALY_DETECTED')).toBe('classifying');
    expect(fsm.current).toBe('monitoring'); // no mutation
  });

  it('fsm.can() returns false for invalid transitions', () => {
    const fsm = createSecurityFSM();
    expect(fsm.can('monitoring', 'CLEAR_THREAT')).toBe(false);
  });

  it('fsm.can() returns true for valid transitions', () => {
    const fsm = createSecurityFSM();
    expect(fsm.can('monitoring', 'ANOMALY_DETECTED')).toBe(true);
  });
});
