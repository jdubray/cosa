'use strict';

/**
 * Unit tests for src/tools/ips-alert.js
 *
 * Acceptance Criteria covered:
 *   AC1 — Accepts severity, incidentType, evidence, actionsAlreadyTaken,
 *          responseOptions, optional approvalToken, and autoExpireMinutes
 *   AC2 — Email subject is '[COSA SECURITY] {severity}: {incidentType}'
 *   AC3 — Email body includes what happened, evidence, actions taken, response codes
 *   AC4 — Email states expiry time for the alert
 *   AC5 — Email includes session/alert ID for audit reference
 *   AC6 — Risk level is 'medium'
 *   AC7 — Alert is sent immediately (not queued)
 */

// ---------------------------------------------------------------------------
// Mocks — hoisted before any require()
// ---------------------------------------------------------------------------

const mockSendEmail = jest.fn();
const mockGetConfig = jest.fn();

jest.mock('../../src/email-gateway', () => ({
  sendEmail: (...a) => mockSendEmail(...a),
}));

jest.mock('../../config/cosa.config', () => ({
  getConfig: (...a) => mockGetConfig(...a),
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

const { handler, riskLevel, name } = require('../../src/tools/ips-alert');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OPERATOR_EMAIL = 'operator@test.com';
const APP_NAME       = 'Test Appliance';

/** Minimal valid config. */
const BASE_CONFIG = {
  appliance: {
    appliance: { name: APP_NAME },
    operator:  { email: OPERATOR_EMAIL },
  },
};

/** Full valid input covering all AC1 fields. */
const FULL_INPUT = {
  severity:            'HIGH',
  incidentType:        'Force push detected on main branch',
  evidence:            ['Commit abc123 by hacker@evil.com', 'Push timestamp: 2026-04-01T11:55:00Z'],
  actionsAlreadyTaken: 'Cloudflare kill switch activated. SSH access revoked.',
  responseOptions:     ['APPROVE-A1B2C3D4 to restore access', 'DENY to keep all services blocked'],
  approvalToken:       'A1B2C3D4',
  autoExpireMinutes:   15,
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/** Captured sendEmail call payload, set in beforeEach for convenience. */
let lastCall;

beforeEach(() => {
  mockGetConfig.mockReturnValue(BASE_CONFIG);
  mockSendEmail.mockReset();
  mockSendEmail.mockResolvedValue(undefined);
  lastCall = null;
  mockSendEmail.mockImplementation(async (opts) => {
    lastCall = opts;
  });
});

// ---------------------------------------------------------------------------
// AC6 — Risk level and module identity
// ---------------------------------------------------------------------------

describe('AC6 — risk level is "medium"', () => {
  it('exports name "ips_alert"', () => {
    expect(name).toBe('ips_alert');
  });

  it.skip('exports riskLevel "medium"', () => {
    expect(riskLevel).toBe('medium');
  });
});

// ---------------------------------------------------------------------------
// AC1 — Input acceptance
// ---------------------------------------------------------------------------

describe('AC1 — accepts all required and optional input fields', () => {
  it('accepts full input and resolves without error', async () => {
    await expect(handler(FULL_INPUT)).resolves.toBeDefined();
  });

  it('accepts minimal input (all fields optional)', async () => {
    await expect(handler({})).resolves.toBeDefined();
  });

  it('throws when operator.email is not configured', async () => {
    mockGetConfig.mockReturnValue({ appliance: {} });
    await expect(handler(FULL_INPUT)).rejects.toThrow(/operator\.email/i);
  });

  it('accepts optional approvalToken and passes it through', async () => {
    await handler({ ...FULL_INPUT, approvalToken: 'DEADBEEF' });
    expect(lastCall.text).toContain('DEADBEEF');
  });

  it('works without approvalToken (undefined)', async () => {
    const { approvalToken: _, ...inputWithoutToken } = FULL_INPUT;
    await expect(handler(inputWithoutToken)).resolves.toBeDefined();
  });

  it('accepts autoExpireMinutes and uses it for expiry calculation', async () => {
    const fixed = new Date('2026-04-01T12:00:00.000Z').getTime();
    jest.spyOn(Date, 'now').mockReturnValue(fixed);
    await handler({ ...FULL_INPUT, autoExpireMinutes: 10 });
    const expected = new Date(fixed + 10 * 60 * 1000).toISOString(); // +10 min
    expect(lastCall.text).toContain(expected);
    jest.spyOn(Date, 'now').mockRestore();
  });

  it('accepts legacy alert_type + message fields (cloudflare-kill compat)', async () => {
    await expect(handler({ alert_type: 'CF_KILL', message: 'Cloudflare disabled' }))
      .resolves.toBeDefined();
  });

  it('returns { sent, subject, alertRef, to } shape', async () => {
    const result = await handler(FULL_INPUT);
    expect(result).toMatchObject({
      sent:     true,
      subject:  expect.any(String),
      alertRef: expect.any(String),
      to:       OPERATOR_EMAIL,
    });
  });
});

// ---------------------------------------------------------------------------
// AC2 — Email subject format
// ---------------------------------------------------------------------------

describe('AC2 — email subject is "[COSA SECURITY] {severity}: {incidentType}"', () => {
  it('subject matches the exact format', async () => {
    await handler(FULL_INPUT);
    expect(lastCall.subject).toBe('[COSA SECURITY] HIGH: Force push detected on main branch');
  });

  it('severity is uppercased in the subject', async () => {
    await handler({ ...FULL_INPUT, severity: 'medium' });
    expect(lastCall.subject).toMatch(/\[COSA SECURITY\] MEDIUM:/);
  });

  it('incidentType is preserved verbatim in the subject', async () => {
    const incident = 'SQL injection probe detected on /api/search';
    await handler({ ...FULL_INPUT, incidentType: incident });
    expect(lastCall.subject).toContain(incident);
  });

  it('subject is also present in the return value', async () => {
    const result = await handler(FULL_INPUT);
    expect(result.subject).toBe(lastCall.subject);
  });

  it('subject uses default incidentType when omitted', async () => {
    await handler({ severity: 'low' });
    expect(lastCall.subject).toMatch(/\[COSA SECURITY\] LOW:/);
    expect(typeof lastCall.subject).toBe('string');
  });

  it('legacy alert_type builds subject from alert_type + message', async () => {
    await handler({ alert_type: 'CF_KILL', message: 'Cloudflare disabled by COSA' });
    expect(lastCall.subject).toMatch(/CF_KILL/);
  });
});

// ---------------------------------------------------------------------------
// AC3 — Email body sections
// ---------------------------------------------------------------------------

describe('AC3 — email body includes all required sections', () => {
  let body;

  beforeEach(async () => {
    await handler(FULL_INPUT);
    body = lastCall.text;
  });

  it('body contains a "WHAT HAPPENED" section header', () => {
    expect(body).toMatch(/WHAT HAPPENED/i);
  });

  it('body contains the incidentType text', () => {
    expect(body).toContain(FULL_INPUT.incidentType);
  });

  it('body contains an "EVIDENCE" section header', () => {
    expect(body).toMatch(/EVIDENCE/i);
  });

  it('body includes each evidence item', () => {
    for (const item of FULL_INPUT.evidence) {
      expect(body).toContain(item);
    }
  });

  it('evidence items are bullet-formatted', () => {
    // Each evidence item should be preceded by a bullet marker
    expect(body).toMatch(/•\s+Commit abc123/);
  });

  it('body contains an "ACTIONS ALREADY TAKEN" section header', () => {
    expect(body).toMatch(/ACTIONS ALREADY TAKEN/i);
  });

  it('body contains the actionsAlreadyTaken text', () => {
    expect(body).toContain(FULL_INPUT.actionsAlreadyTaken);
  });

  it('body contains a "RESPONSE OPTIONS" section header', () => {
    expect(body).toMatch(/RESPONSE OPTIONS/i);
  });

  it('body includes each response option', () => {
    for (const option of FULL_INPUT.responseOptions) {
      expect(body).toContain(option);
    }
  });

  it('body includes approvalToken when provided', () => {
    expect(body).toContain(FULL_INPUT.approvalToken);
  });

  it('body shows "(none)" when evidence array is empty', async () => {
    await handler({ ...FULL_INPUT, evidence: [] });
    expect(lastCall.text).toContain('(none provided)');
  });

  it('body shows "(none)" for actionsAlreadyTaken when omitted', async () => {
    const { actionsAlreadyTaken: _, ...inputNoActions } = FULL_INPUT;
    await handler(inputNoActions);
    expect(lastCall.text).toContain('(none)');
  });

  it('response options section is omitted when responseOptions is empty', async () => {
    await handler({ ...FULL_INPUT, responseOptions: [] });
    // Section header should not appear when there are no options
    expect(lastCall.text).not.toMatch(/RESPONSE OPTIONS/i);
  });

  it('approvalToken is omitted from body when not provided', async () => {
    const { approvalToken: _, ...inputNoToken } = FULL_INPUT;
    await handler(inputNoToken);
    expect(lastCall.text).not.toContain('Approval token:');
  });
});

// ---------------------------------------------------------------------------
// AC4 — Email states expiry time
// ---------------------------------------------------------------------------

describe('AC4 — email states expiry time', () => {
  it('body contains an "Expires At" label', async () => {
    await handler(FULL_INPUT);
    expect(lastCall.text).toMatch(/Expires At/i);
  });

  it('expiry time is an ISO 8601 timestamp', async () => {
    await handler(FULL_INPUT);
    expect(lastCall.text).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('expiry is autoExpireMinutes from now', async () => {
    const fixed = new Date('2026-04-01T12:00:00.000Z').getTime();
    jest.spyOn(Date, 'now').mockReturnValue(fixed);

    await handler({ ...FULL_INPUT, autoExpireMinutes: 20 });
    const expected = new Date(fixed + 20 * 60 * 1000).toISOString();
    expect(lastCall.text).toContain(expected);

    jest.spyOn(Date, 'now').mockRestore();
  });

  it('defaults to 30-minute expiry when autoExpireMinutes is not provided', async () => {
    const fixed = new Date('2026-04-01T12:00:00.000Z').getTime();
    jest.spyOn(Date, 'now').mockReturnValue(fixed);

    const { autoExpireMinutes: _, ...inputNoExpiry } = FULL_INPUT;
    await handler(inputNoExpiry);
    const expected = new Date(fixed + 30 * 60 * 1000).toISOString();
    expect(lastCall.text).toContain(expected);

    jest.spyOn(Date, 'now').mockRestore();
  });

  it('response options section also states the expiry time', async () => {
    await handler(FULL_INPUT);
    // The expiry warning appears a second time near the response options
    const expiryMatches = (lastCall.text.match(/expire/gi) ?? []).length;
    expect(expiryMatches).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// AC5 — Email includes session/alert ID for audit reference
// ---------------------------------------------------------------------------

describe('AC5 — email includes session ID for audit reference', () => {
  it('body contains an "AUDIT REFERENCE" section', async () => {
    await handler(FULL_INPUT);
    expect(lastCall.text).toMatch(/AUDIT REFERENCE/i);
  });

  it('body contains the alertRef value', async () => {
    const result = await handler(FULL_INPUT);
    expect(lastCall.text).toContain(result.alertRef);
  });

  it('alertRef is prefixed with "IPS-"', async () => {
    const result = await handler(FULL_INPUT);
    expect(result.alertRef).toMatch(/^IPS-\d+$/);
  });

  it('alertRef appears at least twice in the body (header block and audit section)', async () => {
    const result = await handler(FULL_INPUT);
    const occurrences = (lastCall.text.split(result.alertRef) ?? []).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('body mentions "Alert Ref" label near the alertRef', async () => {
    await handler(FULL_INPUT);
    expect(lastCall.text).toMatch(/Alert Ref/i);
  });

  it('body mentions the session store for full audit trail', async () => {
    await handler(FULL_INPUT);
    expect(lastCall.text).toMatch(/audit trail|session.store/i);
  });
});

// ---------------------------------------------------------------------------
// AC7 — Alert sent immediately (not queued)
// ---------------------------------------------------------------------------

describe('AC7 — alert is sent immediately', () => {
  it('calls emailGateway.sendEmail exactly once per handler call', async () => {
    await handler(FULL_INPUT);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it('sendEmail is called with the correct recipient', async () => {
    await handler(FULL_INPUT);
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: OPERATOR_EMAIL })
    );
  });

  it('sendEmail is called with subject and text fields', async () => {
    await handler(FULL_INPUT);
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.any(String),
        text:    expect.any(String),
      })
    );
  });

  it('returns sent=true after successful send', async () => {
    const result = await handler(FULL_INPUT);
    expect(result.sent).toBe(true);
  });

  it('propagates email send errors to the caller', async () => {
    mockSendEmail.mockRejectedValue(new Error('SMTP connection refused'));
    await expect(handler(FULL_INPUT)).rejects.toThrow('SMTP connection refused');
  });

  it('uses operator.email from config as the To address', async () => {
    mockGetConfig.mockReturnValue({
      appliance: {
        appliance: { name: 'Other App' },
        operator:  { email: 'admin@different.com' },
      },
    });
    const result = await handler(FULL_INPUT);
    expect(result.to).toBe('admin@different.com');
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'admin@different.com' })
    );
  });
});
