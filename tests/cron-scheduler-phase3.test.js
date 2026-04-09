'use strict';

// ---------------------------------------------------------------------------
// Mocks — same pattern as tests/cron-scheduler.test.js
// ---------------------------------------------------------------------------

const mockCronSchedule = jest.fn();
const mockTaskStop     = jest.fn();

jest.mock('node-cron', () => ({
  schedule: (...a) => mockCronSchedule(...a),
}));

const mockGetConfig = jest.fn();
jest.mock('../config/cosa.config', () => ({
  getConfig: (...a) => mockGetConfig(...a),
}));

const mockRunSession = jest.fn();
jest.mock('../src/orchestrator', () => ({
  runSession: (...a) => mockRunSession(...a),
}));

const mockSendEmail = jest.fn();
jest.mock('../src/email-gateway', () => ({
  sendEmail: (...a) => mockSendEmail(...a),
}));

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
  start,
  stop,
  runGitAuditTask,
  runProcessMonitorTask,
  runNetworkScanTask,
  runAccessLogScanTask,
  runWeeklySecurityDigestTask,
  runCredentialAuditTask,
  runComplianceVerifyTask,
  runWebhookHmacVerifyTask,
  runJwtSecretCheckTask,
  runPciAssessmentTask,
  runTokenRotationRemindTask,
  buildGitAuditTrigger,
  buildProcessMonitorTrigger,
  buildNetworkScanTrigger,
  buildAccessLogScanTrigger,
  buildWeeklySecurityDigestTrigger,
  buildCredentialAuditTrigger,
  buildComplianceVerifyTrigger,
  buildWebhookHmacTrigger,
  buildJwtSecretCheckTrigger,
  buildPciAssessmentTrigger,
  buildTokenRotationRemindTrigger,
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

const SESSION = { session_id: 'sess-p3-001', response: 'Done.' };

beforeEach(() => {
  mockGetConfig.mockReturnValue(BASE_CONFIG);
  mockRunSession.mockResolvedValue(SESSION);
  mockSendEmail.mockResolvedValue(undefined);
  mockCreateAlert.mockReturnValue(1);
  mockFindRecentAlert.mockReturnValue(undefined);
  mockCronSchedule.mockReturnValue({ stop: mockTaskStop });
  mockGetLastToolOutput.mockReturnValue({});
});

afterEach(() => {
  stop();
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find all cron.schedule calls that used a specific expression.
 * Returns the array of [expr, callback] tuples matched.
 */
function callsWithExpr(expr) {
  return mockCronSchedule.mock.calls.filter(([e]) => e === expr);
}

// ---------------------------------------------------------------------------
// AC1: git_audit — 6-hourly, ips_alert if severity >= medium
// ---------------------------------------------------------------------------

describe('AC1 – git_audit every 6 hours', () => {
  test('registers git_audit with 0 */6 * * * expression', () => {
    start();
    // At least one 6-hourly task must be registered
    const sixHourly = callsWithExpr('0 */6 * * *');
    expect(sixHourly.length).toBeGreaterThanOrEqual(1);
  });

  test('trigger source is git-audit', () => {
    const trigger = buildGitAuditTrigger();
    expect(trigger.source).toBe('git-audit');
    expect(trigger.type).toBe('cron');
  });

  test('trigger message instructs ips_alert for medium+ severity', () => {
    const { message } = buildGitAuditTrigger();
    expect(message).toMatch(/ips_alert/);
    expect(message).toMatch(/medium|high|critical/i);
  });

  test('creates alert when git_audit severity is medium', async () => {
    mockGetLastToolOutput.mockReturnValue({ severity: 'medium' });
    await runGitAuditTask();
    expect(mockCreateAlert).toHaveBeenCalledWith(expect.objectContaining({
      category: 'git_audit',
      severity: 'medium',
    }));
  });

  test('creates alert when git_audit severity is high', async () => {
    mockGetLastToolOutput.mockReturnValue({ severity: 'high' });
    await runGitAuditTask();
    expect(mockCreateAlert).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'high',
    }));
  });

  test('creates alert when git_audit severity is critical', async () => {
    mockGetLastToolOutput.mockReturnValue({ severity: 'critical' });
    await runGitAuditTask();
    expect(mockCreateAlert).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'critical',
    }));
  });

  test('does NOT create alert when severity is low', async () => {
    mockGetLastToolOutput.mockReturnValue({ severity: 'low' });
    await runGitAuditTask();
    expect(mockCreateAlert).not.toHaveBeenCalled();
  });

  test('does NOT create alert when severity is absent', async () => {
    mockGetLastToolOutput.mockReturnValue({});
    await runGitAuditTask();
    expect(mockCreateAlert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC2: process_monitor — 6-hourly, escalation if severity >= medium
// ---------------------------------------------------------------------------

describe('AC2 – process_monitor every 6 hours', () => {
  test('trigger source is process-monitor', () => {
    const trigger = buildProcessMonitorTrigger();
    expect(trigger.source).toBe('process-monitor');
  });

  test('trigger message instructs ips_alert for escalation', () => {
    const { message } = buildProcessMonitorTrigger();
    expect(message).toMatch(/ips_alert/);
    expect(message).toMatch(/medium|high|critical/i);
  });

  test('creates alert when process_monitor severity is medium', async () => {
    mockGetLastToolOutput.mockReturnValue({ severity: 'medium' });
    await runProcessMonitorTask();
    expect(mockCreateAlert).toHaveBeenCalledWith(expect.objectContaining({
      category: 'process_monitor',
      severity: 'medium',
    }));
  });

  test('does NOT create alert when severity is low', async () => {
    mockGetLastToolOutput.mockReturnValue({ severity: 'low' });
    await runProcessMonitorTask();
    expect(mockCreateAlert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC3: network_scan — 6-hourly, ips_alert if unknown device
// ---------------------------------------------------------------------------

describe('AC3 – network_scan every 6 hours', () => {
  test('trigger source is network-scan', () => {
    const trigger = buildNetworkScanTrigger();
    expect(trigger.source).toBe('network-scan');
  });

  test('trigger message instructs ips_alert for unknown devices', () => {
    const { message } = buildNetworkScanTrigger();
    expect(message).toMatch(/ips_alert/);
    expect(message).toMatch(/unknown|unexpected/i);
  });

  test('creates alert when unknown_devices list is non-empty', async () => {
    mockGetLastToolOutput.mockReturnValue({
      unknown_devices: [{ ip: '192.168.1.99', mac: 'aa:bb:cc:dd:ee:ff' }],
    });
    await runNetworkScanTask();
    expect(mockCreateAlert).toHaveBeenCalledWith(expect.objectContaining({
      category: 'network_scan',
      severity: 'high',
    }));
  });

  test('does NOT create alert when no unknown devices', async () => {
    mockGetLastToolOutput.mockReturnValue({ unknown_devices: [] });
    await runNetworkScanTask();
    expect(mockCreateAlert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC4: access_log_scan — 6-hourly, feeds anomaly classifier
// ---------------------------------------------------------------------------

describe('AC4 – access_log_scan every 6 hours', () => {
  test('trigger source is access-log-scan', () => {
    const trigger = buildAccessLogScanTrigger();
    expect(trigger.source).toBe('access-log-scan');
  });

  test('trigger message mentions anomaly classifier', () => {
    const { message } = buildAccessLogScanTrigger();
    expect(message).toMatch(/anomaly/i);
  });

  test('creates alert when anomalies are detected', async () => {
    mockGetLastToolOutput.mockReturnValue({
      anomalies: [{ type: 'brute_force', count: 50 }],
      severity: 'high',
    });
    await runAccessLogScanTask();
    expect(mockCreateAlert).toHaveBeenCalledWith(expect.objectContaining({
      category: 'access_log_scan',
    }));
  });

  test('does NOT create alert when anomalies list is empty', async () => {
    mockGetLastToolOutput.mockReturnValue({ anomalies: [] });
    await runAccessLogScanTask();
    expect(mockCreateAlert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC5: Weekly security digest — Monday 2:00 AM
// ---------------------------------------------------------------------------

describe('AC5 – weekly security digest Monday 2:00 AM', () => {
  test('registers security_digest with 0 2 * * 1 expression', () => {
    start();
    const mondayTasks = callsWithExpr('0 2 * * 1');
    expect(mondayTasks.length).toBeGreaterThanOrEqual(1);
  });

  test('trigger source is security-digest', () => {
    const trigger = buildWeeklySecurityDigestTrigger();
    expect(trigger.source).toBe('security-digest');
  });

  test('trigger message covers all Phase 3 tools for gathering data', () => {
    const { message } = buildWeeklySecurityDigestTrigger();
    expect(message).toMatch(/git_audit/);
    expect(message).toMatch(/compliance_verify/);
    expect(message).toMatch(/credential_audit/);
  });

  test('sends email to operator when not recently sent', async () => {
    mockFindRecentAlert.mockReturnValue(undefined);
    await runWeeklySecurityDigestTask();
    expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'ops@restaurant.com',
    }));
  });

  test('subject includes appliance name and week date', async () => {
    mockFindRecentAlert.mockReturnValue(undefined);
    await runWeeklySecurityDigestTask();
    const [{ subject }] = mockSendEmail.mock.calls[0];
    expect(subject).toMatch(/Weekly Security Digest/);
    expect(subject).toMatch(/BaanbaanPi/);
  });

  test('does NOT send email when a recent digest exists (dedup)', async () => {
    mockFindRecentAlert.mockReturnValue({ sent_at: new Date().toISOString() });
    await runWeeklySecurityDigestTask();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  test('creates alert record after sending', async () => {
    await runWeeklySecurityDigestTask();
    expect(mockCreateAlert).toHaveBeenCalledWith(expect.objectContaining({
      category: 'security_digest',
      severity: 'info',
    }));
  });
});

// ---------------------------------------------------------------------------
// AC6: credential_audit — Monday 2:00 AM, ips_alert if any finding
// ---------------------------------------------------------------------------

describe('AC6 – credential_audit Monday 2:00 AM', () => {
  test('trigger source is credential-audit', () => {
    const trigger = buildCredentialAuditTrigger();
    expect(trigger.source).toBe('credential-audit');
  });

  test('trigger message instructs ips_alert if finding present', () => {
    const { message } = buildCredentialAuditTrigger();
    expect(message).toMatch(/ips_alert/);
    expect(message).toMatch(/finding/i);
  });

  test('creates alert when credential_audit has findings', async () => {
    mockGetLastToolOutput.mockReturnValue({
      findings: [{ file: '.env', severity: 'critical' }],
    });
    await runCredentialAuditTask();
    expect(mockCreateAlert).toHaveBeenCalledWith(expect.objectContaining({
      category: 'credential_audit',
    }));
  });

  test('does NOT create alert when no findings', async () => {
    mockGetLastToolOutput.mockReturnValue({ findings: [] });
    await runCredentialAuditTask();
    expect(mockCreateAlert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC7: compliance_verify — Monday 2:00 AM, included in weekly digest
// ---------------------------------------------------------------------------

describe('AC7 – compliance_verify Monday 2:00 AM', () => {
  test('trigger source is compliance-verify', () => {
    const trigger = buildComplianceVerifyTrigger();
    expect(trigger.source).toBe('compliance-verify');
  });

  test('trigger message says result feeds into weekly digest', () => {
    const { message } = buildComplianceVerifyTrigger();
    expect(message).toMatch(/digest|compliance/i);
  });

  test('always creates alert record (to feed into digest)', async () => {
    mockGetLastToolOutput.mockReturnValue({ overallStatus: 'compliant' });
    await runComplianceVerifyTask();
    expect(mockCreateAlert).toHaveBeenCalledWith(expect.objectContaining({
      category: 'compliance_verify',
    }));
  });

  test('uses warning severity when non_compliant', async () => {
    mockGetLastToolOutput.mockReturnValue({ overallStatus: 'non_compliant' });
    await runComplianceVerifyTask();
    expect(mockCreateAlert).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'warning',
    }));
  });

  test('uses info severity when compliant', async () => {
    mockGetLastToolOutput.mockReturnValue({ overallStatus: 'compliant' });
    await runComplianceVerifyTask();
    expect(mockCreateAlert).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'info',
    }));
  });
});

// ---------------------------------------------------------------------------
// AC8: webhook_hmac_verify — Monday 2:00 AM, critical alert if HMAC inactive
// ---------------------------------------------------------------------------

describe('AC8 – webhook_hmac_verify Monday 2:00 AM', () => {
  test('trigger source is webhook-hmac-verify', () => {
    const trigger = buildWebhookHmacTrigger();
    expect(trigger.source).toBe('webhook-hmac-verify');
  });

  test('trigger message instructs critical ips_alert if HMAC inactive', () => {
    const { message } = buildWebhookHmacTrigger();
    expect(message).toMatch(/ips_alert/);
    expect(message).toMatch(/critical|HMAC/i);
  });

  test('creates critical alert when inactive endpoints detected', async () => {
    mockGetLastToolOutput.mockReturnValue({
      inactive: ['/api/webhooks/pos/test-merchant'],
    });
    await runWebhookHmacVerifyTask();
    expect(mockCreateAlert).toHaveBeenCalledWith(expect.objectContaining({
      category: 'webhook_hmac_verify',
      severity: 'critical',
    }));
  });

  test('does NOT create alert when no inactive endpoints', async () => {
    mockGetLastToolOutput.mockReturnValue({ inactive: [] });
    await runWebhookHmacVerifyTask();
    expect(mockCreateAlert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC9: jwt_secret_check — Monday 2:00 AM, reminder if rotation due
// ---------------------------------------------------------------------------

describe('AC9 – jwt_secret_check Monday 2:00 AM', () => {
  test('trigger source is jwt-secret-check', () => {
    const trigger = buildJwtSecretCheckTrigger();
    expect(trigger.source).toBe('jwt-secret-check');
  });

  test('trigger message instructs ips_alert if rotation due', () => {
    const { message } = buildJwtSecretCheckTrigger();
    expect(message).toMatch(/ips_alert/);
    expect(message).toMatch(/rotation/i);
  });

  test('creates alert when secrets are due for rotation', async () => {
    mockGetLastToolOutput.mockReturnValue({
      rotation_due: ['jwt_secret'],
    });
    await runJwtSecretCheckTask();
    expect(mockCreateAlert).toHaveBeenCalledWith(expect.objectContaining({
      category: 'jwt_secret_check',
      severity: 'warning',
    }));
  });

  test('does NOT create alert when no secrets are due', async () => {
    mockGetLastToolOutput.mockReturnValue({ rotation_due: [] });
    await runJwtSecretCheckTask();
    expect(mockCreateAlert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC10: pci_assessment — monthly 1st 2:00 AM, emails full report
// ---------------------------------------------------------------------------

describe('AC10 – pci_assessment monthly 1st 2:00 AM', () => {
  test('registers pci_assessment with 0 2 1 * * expression', () => {
    start();
    const monthlyTasks = callsWithExpr('0 2 1 * *');
    expect(monthlyTasks.length).toBeGreaterThanOrEqual(1);
  });

  test('trigger source is pci-assessment', () => {
    const trigger = buildPciAssessmentTrigger();
    expect(trigger.source).toBe('pci-assessment');
  });

  test('trigger message instructs email of full SAQ-A report', () => {
    const { message } = buildPciAssessmentTrigger();
    expect(message).toMatch(/SAQ-A|pci_assessment/i);
    expect(message).toMatch(/email/i);
  });

  test('sends email to operator with correct subject format', async () => {
    mockFindRecentAlert.mockReturnValue(undefined);
    await runPciAssessmentTask();
    expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'ops@restaurant.com',
    }));
    const [{ subject }] = mockSendEmail.mock.calls[0];
    expect(subject).toMatch(/\[COSA\] Monthly PCI Assessment:/);
  });

  test('does NOT send email within 25-day dedup window', async () => {
    mockFindRecentAlert.mockReturnValue({ sent_at: new Date().toISOString() });
    await runPciAssessmentTask();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  test('creates alert record after sending', async () => {
    mockFindRecentAlert.mockReturnValue(undefined);
    await runPciAssessmentTask();
    expect(mockCreateAlert).toHaveBeenCalledWith(expect.objectContaining({
      category: 'pci_assessment',
      severity: 'info',
    }));
  });
});

// ---------------------------------------------------------------------------
// AC11: token_rotation_remind — monthly 1st 2:00 AM
// ---------------------------------------------------------------------------

describe('AC11 – token_rotation_remind monthly 1st 2:00 AM', () => {
  test('trigger source is token-rotation-remind', () => {
    const trigger = buildTokenRotationRemindTrigger();
    expect(trigger.source).toBe('token-rotation-remind');
  });

  test('trigger message instructs reminder email for due tokens', () => {
    const { message } = buildTokenRotationRemindTrigger();
    expect(message).toMatch(/token_rotation_remind/);
    expect(message).toMatch(/rotation|reminder/i);
  });

  test('sends email when response indicates tokens are due', async () => {
    mockFindRecentAlert.mockReturnValue(undefined);
    mockRunSession.mockResolvedValue({
      session_id: 'sess-trr',
      response: 'JWT secret is due for rotation in 5 days.',
    });
    await runTokenRotationRemindTask();
    expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'ops@restaurant.com',
    }));
  });

  test('does NOT send email when response says no tokens due', async () => {
    mockFindRecentAlert.mockReturnValue(undefined);
    mockRunSession.mockResolvedValue({
      session_id: 'sess-trr',
      response: 'No tokens are due for rotation.',
    });
    await runTokenRotationRemindTask();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  test('does NOT send email within 25-day dedup window', async () => {
    mockFindRecentAlert.mockReturnValue({ sent_at: new Date().toISOString() });
    await runTokenRotationRemindTask();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Registration: all Phase 3 tasks use correct cron expressions
// ---------------------------------------------------------------------------

describe('cron schedule registration', () => {
  test('start() registers 4 tasks on 6-hourly expression', () => {
    start();
    expect(callsWithExpr('0 */6 * * *').length).toBe(4);
  });

  test('start() registers at least 5 tasks on Monday 2:00 AM expression', () => {
    start();
    expect(callsWithExpr('0 2 * * 1').length).toBeGreaterThanOrEqual(5);
  });

  test('start() registers exactly 2 tasks on monthly 1st 2:00 AM expression', () => {
    start();
    expect(callsWithExpr('0 2 1 * *').length).toBe(2);
  });

  test('all task runners are exported', () => {
    expect(typeof runGitAuditTask).toBe('function');
    expect(typeof runProcessMonitorTask).toBe('function');
    expect(typeof runNetworkScanTask).toBe('function');
    expect(typeof runAccessLogScanTask).toBe('function');
    expect(typeof runWeeklySecurityDigestTask).toBe('function');
    expect(typeof runCredentialAuditTask).toBe('function');
    expect(typeof runComplianceVerifyTask).toBe('function');
    expect(typeof runWebhookHmacVerifyTask).toBe('function');
    expect(typeof runJwtSecretCheckTask).toBe('function');
    expect(typeof runPciAssessmentTask).toBe('function');
    expect(typeof runTokenRotationRemindTask).toBe('function');
  });
});
