'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCronSchedule = jest.fn();
jest.mock('node-cron', () => ({ schedule: (...a) => mockCronSchedule(...a) }));

const mockGetConfig = jest.fn();
jest.mock('../config/cosa.config', () => ({ getConfig: (...a) => mockGetConfig(...a) }));

const mockRunSession = jest.fn();
jest.mock('../src/orchestrator', () => ({ runSession: (...a) => mockRunSession(...a) }));

const mockSendEmail = jest.fn();
jest.mock('../src/email-gateway', () => ({ sendEmail: (...a) => mockSendEmail(...a) }));

const mockCreateAlert      = jest.fn();
const mockFindRecentAlert  = jest.fn();
const mockGetLastToolOutput = jest.fn();
jest.mock('../src/session-store', () => ({
  createAlert:       (...a) => mockCreateAlert(...a),
  findRecentAlert:   (...a) => mockFindRecentAlert(...a),
  getLastToolOutput: (...a) => mockGetLastToolOutput(...a),
}));

jest.mock('../src/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

const {
  runWeeklySecurityDigestTask,
  buildWeeklySecurityDigestTrigger,
  _getMondayDateString,
} = require('../src/cron-scheduler');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_CONFIG = {
  appliance: {
    operator:  { email: 'ops@restaurant.com' },
    appliance: { name: 'BaanbaanPi' },
    cron:      {},
  },
};

const DIGEST_BODY = `BaanbaanPi — Weekly Security Digest — week of 2026-03-30

GIT AUDIT ✓ No findings this week.

PROCESS MONITOR ✓ All expected processes running.

NETWORK ✓ All devices known.

ACCESS LOG ANOMALIES ✓ No anomalies detected.

COMPLIANCE — SAQ-A: compliant | JWT last rotated: 2026-01-01 | Next rotation: 2026-04-01

CREDENTIALS ✓ No exposed credentials. .gitignore covers .env and secrets/.

SECURITY INCIDENTS THIS WEEK: 0

Next scan: 2026-04-07 | Next PCI assessment: 2026-05-01

— COSA Security Monitor`;

const SESSION_WITH_BODY = { session_id: 'sess-sd-001', response: DIGEST_BODY };

beforeEach(() => {
  mockGetConfig.mockReturnValue(BASE_CONFIG);
  mockRunSession.mockResolvedValue(SESSION_WITH_BODY);
  mockSendEmail.mockResolvedValue(undefined);
  mockCreateAlert.mockReturnValue(1);
  mockFindRecentAlert.mockReturnValue(undefined);
  mockCronSchedule.mockReturnValue({ stop: jest.fn() });
  mockGetLastToolOutput.mockReturnValue({});
});

afterEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// AC1: Subject line format
// ---------------------------------------------------------------------------

describe('AC1 – subject line format', () => {
  test("subject is '[COSA] Weekly Security Digest — {name} — {date}'", async () => {
    await runWeeklySecurityDigestTask();
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const [{ subject }] = mockSendEmail.mock.calls[0];
    expect(subject).toMatch(/^\[COSA\] Weekly Security Digest — .+ — \d{4}-\d{2}-\d{2}$/);
  });

  test('subject contains the appliance name from config', async () => {
    await runWeeklySecurityDigestTask();
    const [{ subject }] = mockSendEmail.mock.calls[0];
    expect(subject).toContain('BaanbaanPi');
  });

  test('subject contains the Monday ISO date for the current week', async () => {
    await runWeeklySecurityDigestTask();
    const [{ subject }] = mockSendEmail.mock.calls[0];
    const weekOf = _getMondayDateString();
    expect(subject).toContain(weekOf);
  });

  test("falls back to 'COSA' when appliance.appliance.name is absent", async () => {
    mockGetConfig.mockReturnValue({
      appliance: { operator: { email: 'ops@restaurant.com' } },
    });
    await runWeeklySecurityDigestTask();
    const [{ subject }] = mockSendEmail.mock.calls[0];
    expect(subject).toContain('COSA');
  });
});

// ---------------------------------------------------------------------------
// AC2: Trigger message instructs gathering all required sections
// ---------------------------------------------------------------------------

describe('AC2 – trigger message covers all required security sections', () => {
  let message;
  beforeEach(() => { message = buildWeeklySecurityDigestTrigger().message; });

  test('instructs gathering git_audit data', () => {
    expect(message).toMatch(/git_audit/);
  });

  test('instructs gathering process_monitor data', () => {
    expect(message).toMatch(/process_monitor/);
  });

  test('instructs gathering network_scan data', () => {
    expect(message).toMatch(/network_scan/);
  });

  test('instructs gathering access_log data', () => {
    expect(message).toMatch(/access_log/);
  });

  test('instructs running credential_audit', () => {
    expect(message).toMatch(/credential_audit/);
  });

  test('instructs running compliance_verify', () => {
    expect(message).toMatch(/compliance_verify/);
  });

  test('instructs a GIT AUDIT section in the email', () => {
    expect(message).toMatch(/GIT AUDIT/);
  });

  test('instructs a PROCESS MONITOR section in the email', () => {
    expect(message).toMatch(/PROCESS MONITOR/);
  });

  test('instructs a NETWORK section in the email', () => {
    expect(message).toMatch(/NETWORK/);
  });

  test('instructs an ACCESS LOG section in the email', () => {
    expect(message).toMatch(/ACCESS LOG/i);
  });

  test('instructs a COMPLIANCE section in the email', () => {
    expect(message).toMatch(/COMPLIANCE/);
  });

  test('instructs a CREDENTIALS section in the email', () => {
    expect(message).toMatch(/CREDENTIALS/);
  });
});

// ---------------------------------------------------------------------------
// AC3: Trigger message instructs ✓ / ⚠ indicators
// ---------------------------------------------------------------------------

describe('AC3 – trigger message instructs checkmark/warning indicators', () => {
  test('instructs ✓ symbol for clean results', () => {
    const { message } = buildWeeklySecurityDigestTrigger();
    expect(message).toContain('✓');
  });

  test('instructs ⚠ symbol for anomalies', () => {
    const { message } = buildWeeklySecurityDigestTrigger();
    expect(message).toContain('⚠');
  });

  test('instructs ✓/⚠ usage for git audit section', () => {
    const { message } = buildWeeklySecurityDigestTrigger();
    expect(message).toMatch(/GIT AUDIT.*✓|✓.*GIT AUDIT|GIT AUDIT.*⚠|⚠.*GIT AUDIT/s);
  });

  test('instructs ✓/⚠ usage for network section', () => {
    const { message } = buildWeeklySecurityDigestTrigger();
    expect(message).toMatch(/NETWORK.*✓|✓.*NETWORK|NETWORK.*⚠|⚠.*NETWORK/s);
  });
});

// ---------------------------------------------------------------------------
// AC4: JWT secret rotation due date in compliance section
// ---------------------------------------------------------------------------

describe('AC4 – JWT rotation due date in compliance section', () => {
  test('trigger message instructs including JWT last-rotated date in compliance section', () => {
    const { message } = buildWeeklySecurityDigestTrigger();
    expect(message).toMatch(/JWT/i);
    expect(message).toMatch(/rotation|rotated/i);
  });

  test('trigger message mentions JWT rotation date within COMPLIANCE section context', () => {
    const { message } = buildWeeklySecurityDigestTrigger();
    // The COMPLIANCE section instruction should reference JWT
    const complianceIdx = message.indexOf('COMPLIANCE');
    const jwtIdx        = message.indexOf('JWT');
    expect(complianceIdx).toBeGreaterThan(-1);
    expect(jwtIdx).toBeGreaterThan(-1);
  });
});

// ---------------------------------------------------------------------------
// AC5: Security incidents count
// ---------------------------------------------------------------------------

describe('AC5 – security incidents this week count', () => {
  test('trigger message instructs counting security alert sessions', () => {
    const { message } = buildWeeklySecurityDigestTrigger();
    expect(message).toMatch(/SECURITY INCIDENTS THIS WEEK/);
  });

  test('trigger message instructs counting from the past 7 days', () => {
    const { message } = buildWeeklySecurityDigestTrigger();
    expect(message).toMatch(/7 days/);
    expect(message).toMatch(/alert|incident/i);
  });
});

// ---------------------------------------------------------------------------
// AC6: Next scan and next PCI assessment dates
// ---------------------------------------------------------------------------

describe('AC6 – next scan and next PCI assessment dates in footer', () => {
  test('trigger message includes a computed next scan date in the footer', () => {
    const { message } = buildWeeklySecurityDigestTrigger();
    expect(message).toMatch(/Next scan:/);
    // Date should be 7 days from now
    const nextScanDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    expect(message).toContain(nextScanDate);
  });

  test('trigger message includes a computed next PCI assessment date', () => {
    const { message } = buildWeeklySecurityDigestTrigger();
    expect(message).toMatch(/Next PCI assessment:/);
  });

  test('next PCI assessment date is the 1st of next month', () => {
    const { message } = buildWeeklySecurityDigestTrigger();
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    const expectedDate = d.toISOString().slice(0, 10);
    expect(message).toContain(expectedDate);
  });
});

// ---------------------------------------------------------------------------
// AC7: Plain text — no HTML
// ---------------------------------------------------------------------------

describe('AC7 – email is plain text, no HTML', () => {
  test('trigger message explicitly instructs plain text — no HTML', () => {
    const { message } = buildWeeklySecurityDigestTrigger();
    expect(message).toMatch(/plain.?text/i);
    expect(message).toMatch(/no HTML/i);
  });

  test('email is sent using the text field, not an html field', async () => {
    await runWeeklySecurityDigestTask();
    const [emailArgs] = mockSendEmail.mock.calls[0];
    expect(emailArgs.text).toBeDefined();
    expect(emailArgs.html).toBeUndefined();
  });

  test('email body is the orchestrator response (Claude-generated text)', async () => {
    await runWeeklySecurityDigestTask();
    const [{ text }] = mockSendEmail.mock.calls[0];
    expect(text).toBe(DIGEST_BODY);
  });

  test('falls back to placeholder text when orchestrator returns empty response', async () => {
    mockRunSession.mockResolvedValue({ session_id: 'sess-empty', response: '' });
    await runWeeklySecurityDigestTask();
    const [{ text }] = mockSendEmail.mock.calls[0];
    expect(text).toMatch(/No security digest data available/);
  });
});

// ---------------------------------------------------------------------------
// AC8: Deduplication — no second digest within 6 days
// ---------------------------------------------------------------------------

describe('AC8 – deduplication within 6 days', () => {
  test('does NOT send email when a recent digest exists', async () => {
    mockFindRecentAlert.mockReturnValue({ sent_at: new Date().toISOString() });
    await runWeeklySecurityDigestTask();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  test('does NOT run orchestrator session when dedup suppresses', async () => {
    mockFindRecentAlert.mockReturnValue({ sent_at: new Date().toISOString() });
    await runWeeklySecurityDigestTask();
    expect(mockRunSession).not.toHaveBeenCalled();
  });

  test('queries findRecentAlert with security_digest category', async () => {
    await runWeeklySecurityDigestTask();
    expect(mockFindRecentAlert).toHaveBeenCalledWith(
      'security_digest',
      'info',
      expect.any(String)
    );
  });

  test('dedup window is 6 days — sinceIso is approximately 6 days ago', async () => {
    await runWeeklySecurityDigestTask();
    const [, , sinceIso] = mockFindRecentAlert.mock.calls[0];
    const sinceMs = Date.now() - new Date(sinceIso).getTime();
    const sixDaysMs = 6 * 24 * 60 * 60 * 1000;
    // Allow ±5 seconds for test execution time
    expect(Math.abs(sinceMs - sixDaysMs)).toBeLessThan(5000);
  });

  test('sends email when no recent digest found', async () => {
    mockFindRecentAlert.mockReturnValue(undefined);
    await runWeeklySecurityDigestTask();
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  test('creates alert record after sending (for future dedup lookups)', async () => {
    await runWeeklySecurityDigestTask();
    expect(mockCreateAlert).toHaveBeenCalledWith(expect.objectContaining({
      category:   'security_digest',
      severity:   'info',
      email_to:   'ops@restaurant.com',
    }));
  });

  test('alert record title matches the sent subject', async () => {
    await runWeeklySecurityDigestTask();
    const [emailArgs] = mockSendEmail.mock.calls[0];
    const [alertArgs] = mockCreateAlert.mock.calls[0];
    expect(alertArgs.title).toBe(emailArgs.subject);
  });
});

// ---------------------------------------------------------------------------
// Trigger structure
// ---------------------------------------------------------------------------

describe('trigger structure', () => {
  test('trigger type is cron', () => {
    const trigger = buildWeeklySecurityDigestTrigger();
    expect(trigger.type).toBe('cron');
  });

  test('trigger source is security-digest', () => {
    const trigger = buildWeeklySecurityDigestTrigger();
    expect(trigger.source).toBe('security-digest');
  });

  test('trigger message contains current ISO timestamp', () => {
    const before  = new Date().toISOString().slice(0, 16);
    const { message } = buildWeeklySecurityDigestTrigger();
    expect(message).toContain(before);
  });

  test('runWeeklySecurityDigestTask sends trigger to orchestrator', async () => {
    await runWeeklySecurityDigestTask();
    const [trigger] = mockRunSession.mock.calls[0];
    expect(trigger.type).toBe('cron');
    expect(trigger.source).toBe('security-digest');
  });
});

// ---------------------------------------------------------------------------
// _getMondayDateString helper
// ---------------------------------------------------------------------------

describe('_getMondayDateString', () => {
  test('returns a valid YYYY-MM-DD date string', () => {
    const result = _getMondayDateString();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('returned date is within the past 7 days (i.e. the most recent Monday)', () => {
    const result     = _getMondayDateString();
    // Parse in local time (matching how the function computes the date)
    const returnedMs = new Date(result).getTime();
    const nowMs      = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    // The Monday date should be between 6 days ago and tomorrow (allowing for timezone offsets)
    expect(returnedMs).toBeGreaterThan(nowMs - sevenDaysMs);
    expect(returnedMs).toBeLessThanOrEqual(nowMs + 24 * 60 * 60 * 1000);
  });

  test('returned date is not in the future', () => {
    const result = _getMondayDateString();
    expect(new Date(result + 'T00:00:00Z').getTime()).toBeLessThanOrEqual(Date.now());
  });
});
