'use strict';

// ---------------------------------------------------------------------------
// runObservationMonitorsTask — per-monitor dedup window.
//
// Regression: payments_missing_processor_fee emailed the operator every ~3h
// (the global OBSERVATION_DEDUP_WINDOW_MS) for a sustained backlog. Monitors can
// now set `dedup_window_minutes`; the fee monitor uses ~1 email/day.
// ---------------------------------------------------------------------------

jest.mock('node-cron', () => ({ schedule: jest.fn(() => ({ stop: jest.fn() })) }));

const mockGetConfig = jest.fn();
jest.mock('../config/cosa.config', () => ({ getConfig: (...a) => mockGetConfig(...a) }));

jest.mock('../src/orchestrator', () => ({ runSession: jest.fn() }));

const mockSendEmail = jest.fn();
jest.mock('../src/email-gateway', () => ({ sendEmail: (...a) => mockSendEmail(...a) }));

const mockCreateAlert    = jest.fn();
const mockFindMostRecent = jest.fn(() => null);
jest.mock('../src/session-store', () => ({
  createAlert:                     (...a) => mockCreateAlert(...a),
  findMostRecentAlertByCategories: (...a) => mockFindMostRecent(...a),
  findRecentAlert:                 jest.fn(() => undefined),
  findLastAlertByCategory:         jest.fn(() => null),
  getLastToolOutput:               jest.fn(() => ({})),
  countAlertsByCategoriesSince:    jest.fn(() => 0),
  getDb:                           jest.fn(() => ({ prepare: () => ({ get: () => ({ n: 0 }), all: () => [] }) })),
}));

jest.mock('../src/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

jest.mock('../src/ssh-backend', () => ({ isConnected: () => true }));

const mockEvaluateMonitor = jest.fn();
jest.mock('../src/observation-monitor', () => ({
  evaluateMonitor: (...a) => mockEvaluateMonitor(...a),
}));

// Mutable stand-in for config/observation-monitors.js (jest allows `mock*` vars).
const mockDefs = [];
jest.mock('../config/observation-monitors', () => mockDefs);

const { runObservationMonitorsTask, observationDedupWindowMs } = require('../src/cron-scheduler');
const realDefs = jest.requireActual('../config/observation-monitors');

const HOUR = 60 * 60 * 1000;
const agoIso = (ms) => new Date(Date.now() - ms).toISOString();

beforeEach(() => {
  mockGetConfig.mockReturnValue({
    appliance: { operator: { email: 'ops@cafe.com' }, appliance: { name: 'Cafe' }, cron: {} },
  });
  mockSendEmail.mockResolvedValue(undefined);
  mockEvaluateMonitor.mockResolvedValue({ severity: 'high', value: 1885, report: 'body' });
  mockFindMostRecent.mockReturnValue(null);
  mockDefs.length = 0;
});

afterEach(() => jest.clearAllMocks());

describe('observationDedupWindowMs', () => {
  test('defaults to 3h when the monitor sets no override', () => {
    expect(observationDedupWindowMs({ id: 'x' })).toBe(3 * HOUR);
  });

  test('uses dedup_window_minutes when set', () => {
    expect(observationDedupWindowMs({ id: 'x', dedup_window_minutes: 90 })).toBe(90 * 60 * 1000);
  });

  test.each([0, -5, NaN, '60', null, Infinity])('ignores invalid override %p', (bad) => {
    expect(observationDedupWindowMs({ id: 'x', dedup_window_minutes: bad })).toBe(3 * HOUR);
  });
});

describe('runObservationMonitorsTask — dedup window', () => {
  test('default monitor re-emails after 3h (unchanged behavior)', async () => {
    mockDefs.push({ id: 'plain', enabled: true });
    mockFindMostRecent.mockReturnValue({ sent_at: agoIso(3 * HOUR + 60_000) });
    await runObservationMonitorsTask();
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  test('default monitor is suppressed inside 3h', async () => {
    mockDefs.push({ id: 'plain', enabled: true });
    mockFindMostRecent.mockReturnValue({ sent_at: agoIso(2 * HOUR) });
    await runObservationMonitorsTask();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  test('monitor with a 23h override is suppressed at 20h, sends at 23h+', async () => {
    mockDefs.push({ id: 'daily', enabled: true, dedup_window_minutes: 23 * 60 });
    mockFindMostRecent.mockReturnValue({ sent_at: agoIso(20 * HOUR) });
    await runObservationMonitorsTask();
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockCreateAlert).not.toHaveBeenCalled();

    mockFindMostRecent.mockReturnValue({ sent_at: agoIso(23 * HOUR + 60_000) });
    await runObservationMonitorsTask();
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockCreateAlert).toHaveBeenCalledTimes(1);
  });
});

describe('config — payments_missing_processor_fee', () => {
  const def = realDefs.find(d => d.id === 'payments_missing_processor_fee');

  test('is paused (Finix issue) and, once re-enabled, emails about once a day', () => {
    expect(def.enabled).toBe(false);
    // Under 24h on purpose: the task ticks every 15 min, so a 24h window would
    // make the send time creep ~15 min later each day.
    expect(def.dedup_window_minutes).toBeGreaterThanOrEqual(22 * 60);
    expect(def.dedup_window_minutes).toBeLessThan(24 * 60);
  });
});
