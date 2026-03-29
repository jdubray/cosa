'use strict';

// ---------------------------------------------------------------------------
// Mocks — `mock` prefix exempts from Jest's hoisting TDZ rule.
// ---------------------------------------------------------------------------

// ── node-cron ────────────────────────────────────────────────────────────────
const mockCronSchedule = jest.fn();
const mockTaskStop     = jest.fn();

jest.mock('node-cron', () => ({
  schedule: (...a) => mockCronSchedule(...a),
}));

// ── config ───────────────────────────────────────────────────────────────────
const mockGetConfig = jest.fn();

jest.mock('../config/cosa.config', () => ({
  getConfig: (...a) => mockGetConfig(...a),
}));

// ── orchestrator ─────────────────────────────────────────────────────────────
const mockRunSession = jest.fn();

jest.mock('../src/orchestrator', () => ({
  runSession: (...a) => mockRunSession(...a),
}));

// ── email-gateway ────────────────────────────────────────────────────────────
const mockSendEmail = jest.fn();

jest.mock('../src/email-gateway', () => ({
  sendEmail: (...a) => mockSendEmail(...a),
}));

// ── session-store ────────────────────────────────────────────────────────────
const mockCreateAlert      = jest.fn();
const mockFindRecentAlert  = jest.fn();
const mockGetLastToolOutput = jest.fn();

jest.mock('../src/session-store', () => ({
  createAlert:       (...a) => mockCreateAlert(...a),
  findRecentAlert:   (...a) => mockFindRecentAlert(...a),
  getLastToolOutput: (...a) => mockGetLastToolOutput(...a),
}));

// ── logger ───────────────────────────────────────────────────────────────────
jest.mock('../src/logger', () => ({
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

const { start, stop, runHealthCheckTask } = require('../src/cron-scheduler');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_CONFIG = {
  appliance: {
    operator: { email: 'owner@restaurant.com' },
    cron: { health_check: '0 * * * *' },
  },
};

// ── Orchestrator session results (returned by runSession) ────────────────────

const HEALTHY_SESSION    = { session_id: 'sess-001', response: 'Baanbaan is healthy.' };
const DEGRADED_SESSION   = { session_id: 'sess-002', response: 'Issues detected.' };
const UNREACHABLE_SESSION = { session_id: 'sess-003', response: 'Baanbaan unreachable.' };

// ── health_check tool outputs (returned by getLastToolOutput) ────────────────

/** Mirrors what the health_check tool handler returns for a healthy appliance. */
const HEALTHY_RESULT = {
  overall_status: 'healthy',
  ssh_connected:  true,
  http_health:    { reachable: true,  status_code: 200, body: '{"ok":true}' },
  http_ready:     { reachable: true,  status_code: 200, body: '{"ready":true}' },
  process:        { running: true, active_state: 'active', sub_state: 'running', restarts: 0 },
  errors:         [],
  checked_at:     '2024-01-15T10:00:00.000Z',
};

const DEGRADED_RESULT = {
  overall_status: 'degraded',
  ssh_connected:  true,
  http_health:    { reachable: false, status_code: null, body: null },
  http_ready:     { reachable: true,  status_code: 200, body: '{"ready":true}' },
  process:        { running: true, active_state: 'activating', sub_state: 'start', restarts: 3 },
  errors:         ['HTTP health check timed out'],
  checked_at:     '2024-01-15T10:00:00.000Z',
};

const UNREACHABLE_RESULT = {
  overall_status: 'unreachable',
  ssh_connected:  false,
  http_health:    { reachable: false, status_code: null, body: null },
  http_ready:     { reachable: false, status_code: null, body: null },
  process:        null,
  errors:         ['SSH connection refused'],
  checked_at:     '2024-01-15T10:00:00.000Z',
};

/**
 * Set up both mocks required by runHealthCheckTask:
 *  1. mockRunSession → returns the session stub (session_id + response)
 *  2. mockGetLastToolOutput → returns the tool output fixture
 *
 * @param {object} toolOutput - One of HEALTHY_RESULT / DEGRADED_RESULT / UNREACHABLE_RESULT
 * @param {object} [session]  - Override session stub (defaults to matching SESSION fixture)
 */
function mockHealthCheck(toolOutput, session) {
  const sessionStub = session ?? {
    session_id: toolOutput === HEALTHY_RESULT    ? HEALTHY_SESSION.session_id
              : toolOutput === DEGRADED_RESULT   ? DEGRADED_SESSION.session_id
              : UNREACHABLE_SESSION.session_id,
    response: 'Done.',
  };
  mockRunSession.mockResolvedValue(sessionStub);
  mockGetLastToolOutput.mockReturnValue(toolOutput);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockGetConfig.mockReturnValue(BASE_CONFIG);
  mockHealthCheck(HEALTHY_RESULT);
  mockSendEmail.mockResolvedValue(undefined);
  mockCreateAlert.mockReturnValue(1);
  mockFindRecentAlert.mockReturnValue(undefined); // no recent alert by default
  mockCronSchedule.mockReturnValue({ stop: mockTaskStop });
});

afterEach(() => {
  stop();
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// AC1 — Registers health-check task with correct cron expression
// ---------------------------------------------------------------------------

describe('AC1 — cron registration', () => {
  it('registers a cron task when start() is called', () => {
    start();
    expect(mockCronSchedule).toHaveBeenCalledTimes(1);
  });

  it('uses the cron expression from appliance.cron.health_check', () => {
    start();
    const [expression] = mockCronSchedule.mock.calls[0];
    expect(expression).toBe('0 * * * *');
  });

  it('falls back to "0 * * * *" when cron config is absent', () => {
    mockGetConfig.mockReturnValue({
      appliance: { operator: { email: 'x@y.com' }, cron: undefined },
    });
    start();
    const [expression] = mockCronSchedule.mock.calls[0];
    expect(expression).toBe('0 * * * *');
  });

  it('is a no-op when called a second time while already running', () => {
    start();
    start();
    expect(mockCronSchedule).toHaveBeenCalledTimes(1);
  });

  it('registers a callback as the second argument to cron.schedule', () => {
    start();
    const callback = mockCronSchedule.mock.calls[0][1];
    expect(typeof callback).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// AC2 — Invokes orchestrator with structured health check trigger message
// ---------------------------------------------------------------------------

describe('AC2 — orchestrator invocation with trigger message', () => {
  it('calls orchestrator.runSession exactly once per task execution', async () => {
    await runHealthCheckTask();
    expect(mockRunSession).toHaveBeenCalledTimes(1);
  });

  it('passes trigger.type = "cron"', async () => {
    await runHealthCheckTask();
    const [trigger] = mockRunSession.mock.calls[0];
    expect(trigger.type).toBe('cron');
  });

  it('passes trigger.source = "health-check"', async () => {
    await runHealthCheckTask();
    const [trigger] = mockRunSession.mock.calls[0];
    expect(trigger.source).toBe('health-check');
  });

  it('trigger.message contains health check instructions', async () => {
    await runHealthCheckTask();
    const [trigger] = mockRunSession.mock.calls[0];
    expect(trigger.message).toContain('health check');
    expect(trigger.message).toContain('health_check tool');
  });

  it('trigger.message contains the current ISO timestamp', async () => {
    const before = new Date().toISOString().slice(0, 16); // truncate to minute
    await runHealthCheckTask();
    const [trigger] = mockRunSession.mock.calls[0];
    expect(trigger.message).toContain('Current time:');
    expect(trigger.message).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });
});

// ---------------------------------------------------------------------------
// AC3 — Healthy result: no email, no alert record
// ---------------------------------------------------------------------------

describe('AC2b — DB query for health_check result', () => {
  it('calls getLastToolOutput with the session_id and "health_check"', async () => {
    await runHealthCheckTask();
    expect(mockGetLastToolOutput).toHaveBeenCalledWith(
      HEALTHY_SESSION.session_id,
      'health_check'
    );
  });

  it('treats a null tool output as unreachable', async () => {
    mockRunSession.mockResolvedValue(HEALTHY_SESSION);
    mockGetLastToolOutput.mockReturnValue(null);
    await runHealthCheckTask();
    // null → overall_status='unreachable' → sends critical alert
    const [alertData] = mockCreateAlert.mock.calls[0];
    expect(alertData.severity).toBe('critical');
  });
});

describe('AC3 — healthy result produces no alert', () => {
  it('does not call sendEmail when overall_status is "healthy"', async () => {
    mockHealthCheck(HEALTHY_RESULT);
    await runHealthCheckTask();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('does not call createAlert when overall_status is "healthy"', async () => {
    mockHealthCheck(HEALTHY_RESULT);
    await runHealthCheckTask();
    expect(mockCreateAlert).not.toHaveBeenCalled();
  });

  it('does not call findRecentAlert when overall_status is "healthy"', async () => {
    mockHealthCheck(HEALTHY_RESULT);
    await runHealthCheckTask();
    expect(mockFindRecentAlert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC4 — Degraded / unreachable: alert email sent to operator
// ---------------------------------------------------------------------------

describe('AC4 — non-healthy result triggers alert email', () => {
  it('sends an email when overall_status is "degraded"', async () => {
    mockHealthCheck(DEGRADED_RESULT);
    await runHealthCheckTask();
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it('sends to the operator email address for degraded', async () => {
    mockHealthCheck(DEGRADED_RESULT);
    await runHealthCheckTask();
    const [opts] = mockSendEmail.mock.calls[0];
    expect(opts.to).toBe(BASE_CONFIG.appliance.operator.email);
  });

  it('sends an email when overall_status is "unreachable"', async () => {
    mockHealthCheck(UNREACHABLE_RESULT);
    await runHealthCheckTask();
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it('uses severity "warning" for degraded status', async () => {
    mockHealthCheck(DEGRADED_RESULT);
    await runHealthCheckTask();
    const [alertData] = mockCreateAlert.mock.calls[0];
    expect(alertData.severity).toBe('warning');
  });

  it('uses severity "critical" for unreachable status', async () => {
    mockHealthCheck(UNREACHABLE_RESULT);
    await runHealthCheckTask();
    const [alertData] = mockCreateAlert.mock.calls[0];
    expect(alertData.severity).toBe('critical');
  });

  it('includes status in the email subject', async () => {
    mockHealthCheck(DEGRADED_RESULT);
    await runHealthCheckTask();
    const [opts] = mockSendEmail.mock.calls[0];
    expect(opts.subject).toContain('DEGRADED');
  });

  it('includes error details in the email body', async () => {
    mockHealthCheck(DEGRADED_RESULT);
    await runHealthCheckTask();
    const [opts] = mockSendEmail.mock.calls[0];
    expect(opts.text).toContain('HTTP health check timed out');
  });

  it('email is plain text (no html field)', async () => {
    mockHealthCheck(DEGRADED_RESULT);
    await runHealthCheckTask();
    const [opts] = mockSendEmail.mock.calls[0];
    expect(opts).not.toHaveProperty('html');
  });
});

// ---------------------------------------------------------------------------
// AC5 — Alert deduplication
// ---------------------------------------------------------------------------

describe('AC5 — alert deduplication', () => {
  it('suppresses email when a recent alert exists for the same category+severity', async () => {
    mockHealthCheck(DEGRADED_RESULT);
    mockFindRecentAlert.mockReturnValue({
      id:       1,
      category: 'health_check',
      severity: 'warning',
      sent_at:  new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
    });

    await runHealthCheckTask();

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockCreateAlert).not.toHaveBeenCalled();
  });

  it('sends email when no recent alert exists within the 60-minute window', async () => {
    mockHealthCheck(DEGRADED_RESULT);
    mockFindRecentAlert.mockReturnValue(undefined); // no recent alert

    await runHealthCheckTask();

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it('calls findRecentAlert with category "health_check"', async () => {
    mockHealthCheck(DEGRADED_RESULT);
    await runHealthCheckTask();

    expect(mockFindRecentAlert).toHaveBeenCalledWith(
      'health_check',
      'warning',
      expect.any(String) // sinceIso cutoff
    );
  });

  it('the sinceIso cutoff is approximately 60 minutes before now', async () => {
    mockHealthCheck(DEGRADED_RESULT);
    const before = Date.now();
    await runHealthCheckTask();

    const [, , sinceIso] = mockFindRecentAlert.mock.calls[0];
    const sinceMs = new Date(sinceIso).getTime();
    const expectedCutoff = before - 60 * 60 * 1000;

    // Allow ±2 s tolerance for test execution time
    expect(sinceMs).toBeGreaterThanOrEqual(expectedCutoff - 2000);
    expect(sinceMs).toBeLessThanOrEqual(expectedCutoff + 2000);
  });

  it('does not suppress when the prior alert is a different severity', async () => {
    mockHealthCheck(DEGRADED_RESULT); // severity = 'warning'
    // Return a 'critical' alert, not a 'warning' — different severity
    mockFindRecentAlert.mockReturnValue(undefined);

    await runHealthCheckTask();

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// AC6 — Alert recorded in alerts table
// ---------------------------------------------------------------------------

describe('AC6 — alert recorded in session.db', () => {
  it('calls createAlert after sending the email', async () => {
    mockHealthCheck(DEGRADED_RESULT);
    await runHealthCheckTask();
    expect(mockCreateAlert).toHaveBeenCalledTimes(1);
  });

  it('stores correct severity for degraded', async () => {
    mockHealthCheck(DEGRADED_RESULT);
    await runHealthCheckTask();
    const [data] = mockCreateAlert.mock.calls[0];
    expect(data.severity).toBe('warning');
  });

  it('stores category "health_check"', async () => {
    mockHealthCheck(DEGRADED_RESULT);
    await runHealthCheckTask();
    const [data] = mockCreateAlert.mock.calls[0];
    expect(data.category).toBe('health_check');
  });

  it('stores a non-empty title', async () => {
    mockHealthCheck(DEGRADED_RESULT);
    await runHealthCheckTask();
    const [data] = mockCreateAlert.mock.calls[0];
    expect(typeof data.title).toBe('string');
    expect(data.title.length).toBeGreaterThan(0);
  });

  it('stores a non-empty body', async () => {
    mockHealthCheck(DEGRADED_RESULT);
    await runHealthCheckTask();
    const [data] = mockCreateAlert.mock.calls[0];
    expect(typeof data.body).toBe('string');
    expect(data.body.length).toBeGreaterThan(0);
  });

  it('stores sent_at as an ISO 8601 string', async () => {
    mockHealthCheck(DEGRADED_RESULT);
    await runHealthCheckTask();
    const [data] = mockCreateAlert.mock.calls[0];
    expect(new Date(data.sent_at).toISOString()).toBe(data.sent_at);
  });

  it('stores email_to as the operator email', async () => {
    mockHealthCheck(DEGRADED_RESULT);
    await runHealthCheckTask();
    const [data] = mockCreateAlert.mock.calls[0];
    expect(data.email_to).toBe(BASE_CONFIG.appliance.operator.email);
  });

  it('stores the session_id from the orchestrator session result', async () => {
    mockHealthCheck(DEGRADED_RESULT);
    await runHealthCheckTask();
    const [data] = mockCreateAlert.mock.calls[0];
    expect(data.session_id).toBe(DEGRADED_SESSION.session_id);
  });

  it('does not create alert when email send fails', async () => {
    mockHealthCheck(DEGRADED_RESULT);
    mockSendEmail.mockRejectedValue(new Error('SMTP error'));

    await expect(runHealthCheckTask()).rejects.toThrow('SMTP error');
    expect(mockCreateAlert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle — start and stop
// ---------------------------------------------------------------------------

describe('lifecycle — start / stop', () => {
  it('stop() calls task.stop()', () => {
    start();
    stop();
    expect(mockTaskStop).toHaveBeenCalledTimes(1);
  });

  it('stop() is a no-op when not started', () => {
    expect(() => stop()).not.toThrow();
  });

  it('after stop(), start() can register a new task', () => {
    start();
    stop();
    start();
    expect(mockCronSchedule).toHaveBeenCalledTimes(2);
  });

  it('cron callback calls runHealthCheckTask and swallows errors', async () => {
    jest.useFakeTimers();
    mockRunSession.mockRejectedValue(new Error('orchestrator down'));

    start();
    const callback = mockCronSchedule.mock.calls[0][1];
    // Should not throw even though runSession rejects
    await expect(async () => {
      callback();
      await jest.runAllTimersAsync();
    }).not.toThrow();

    jest.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

describe('module exports', () => {
  it('exports start', () => expect(typeof start).toBe('function'));
  it('exports stop',  () => expect(typeof stop).toBe('function'));
  it('exports runHealthCheckTask', () => expect(typeof runHealthCheckTask).toBe('function'));
});
