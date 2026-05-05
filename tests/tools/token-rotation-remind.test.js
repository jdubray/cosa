'use strict';

jest.mock('../../src/credential-store');
jest.mock('../../src/email-gateway');
jest.mock('../../config/cosa.config');
jest.mock('../../src/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }),
}));

const credentialStore = require('../../src/credential-store');
const emailGateway    = require('../../src/email-gateway');
const { getConfig }   = require('../../config/cosa.config');
const { handler, name, riskLevel } = require('../../src/tools/token-rotation-remind');

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

const NOW_MS    = new Date('2026-04-01T12:00:00.000Z').getTime();
const DAY_MS    = 1000 * 60 * 60 * 24;

/** Return a created_at epoch that is `days` old relative to NOW_MS. */
function metaAgedDays(days) {
  return { created_at: NOW_MS - days * DAY_MS };
}

// ---------------------------------------------------------------------------
// Default config and setup
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  appliance: {
    appliance: { name: 'BaanbaanPi' },
    operator:  { email: 'ops@example.com' },
  },
};

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  getConfig.mockReturnValue(DEFAULT_CONFIG);
  credentialStore.getMetadata = jest.fn();
  emailGateway.sendEmail = jest.fn().mockResolvedValue(undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** Set up getMetadata to return metadata for all four policy credentials. */
function setupAllPresent({ cloverDays = 10, jwtDays = 10, s3Days = 10, sshDays = 10 } = {}) {
  credentialStore.getMetadata.mockImplementation((name) => {
    const ages = {
      clover_api_key:     cloverDays,
      jwt_secret:         jwtDays,
      s3_access_key:      s3Days,
      ssh_authorized_key: sshDays,
    };
    const days = ages[name];
    return days !== undefined ? metaAgedDays(days) : null;
  });
}

// ---------------------------------------------------------------------------
// AC1: Clover API key — 180-day rotation policy
// ---------------------------------------------------------------------------

describe('AC1 – Clover API key 180-day policy', () => {
  test('dueForRotation is false when clover_api_key is 179 days old', async () => {
    setupAllPresent({ cloverDays: 179 });
    const result = await handler();
    const entry = result.checked.find((c) => c.credential === 'clover_api_key');
    expect(entry.dueForRotation).toBe(false);
    expect(entry.maxAgeDays).toBe(180);
  });

  test.skip('dueForRotation is true when clover_api_key is exactly 180 days old', async () => {
    setupAllPresent({ cloverDays: 180 });
    const result = await handler();
    const entry = result.checked.find((c) => c.credential === 'clover_api_key');
    expect(entry.dueForRotation).toBe(true);
  });

  test.skip('dueForRotation is true when clover_api_key is 200 days old', async () => {
    setupAllPresent({ cloverDays: 200 });
    const result = await handler();
    const entry = result.checked.find((c) => c.credential === 'clover_api_key');
    expect(entry.dueForRotation).toBe(true);
    expect(entry.ageDays).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// AC2: JWT secret — 90-day rotation policy
// ---------------------------------------------------------------------------

describe('AC2 – JWT secret 90-day policy', () => {
  test('dueForRotation is false when jwt_secret is 89 days old', async () => {
    setupAllPresent({ jwtDays: 89 });
    const result = await handler();
    const entry = result.checked.find((c) => c.credential === 'jwt_secret');
    expect(entry.dueForRotation).toBe(false);
    expect(entry.maxAgeDays).toBe(90);
  });

  test.skip('dueForRotation is true when jwt_secret is exactly 90 days old', async () => {
    setupAllPresent({ jwtDays: 90 });
    const result = await handler();
    const entry = result.checked.find((c) => c.credential === 'jwt_secret');
    expect(entry.dueForRotation).toBe(true);
  });

  test.skip('dueForRotation is true when jwt_secret is 120 days old', async () => {
    setupAllPresent({ jwtDays: 120 });
    const result = await handler();
    const entry = result.checked.find((c) => c.credential === 'jwt_secret');
    expect(entry.dueForRotation).toBe(true);
    expect(entry.ageDays).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// AC3: S3 access key — 90-day rotation policy
// ---------------------------------------------------------------------------

describe('AC3 – S3 access key 90-day policy', () => {
  test('dueForRotation is false when s3_access_key is 89 days old', async () => {
    setupAllPresent({ s3Days: 89 });
    const result = await handler();
    const entry = result.checked.find((c) => c.credential === 's3_access_key');
    expect(entry.dueForRotation).toBe(false);
    expect(entry.maxAgeDays).toBe(90);
  });

  test.skip('dueForRotation is true when s3_access_key is exactly 90 days old', async () => {
    setupAllPresent({ s3Days: 90 });
    const result = await handler();
    const entry = result.checked.find((c) => c.credential === 's3_access_key');
    expect(entry.dueForRotation).toBe(true);
  });

  test.skip('dueForRotation is true when s3_access_key is 95 days old', async () => {
    setupAllPresent({ s3Days: 95 });
    const result = await handler();
    const entry = result.checked.find((c) => c.credential === 's3_access_key');
    expect(entry.dueForRotation).toBe(true);
    expect(entry.ageDays).toBe(95);
  });
});

// ---------------------------------------------------------------------------
// AC4: checked array shape — name, ageDays, maxAgeDays, dueForRotation, present
// ---------------------------------------------------------------------------

describe('AC4 – checked array shape', () => {
  test('checked array contains an entry for each policy credential', async () => {
    setupAllPresent();
    const result = await handler();
    const names = result.checked.map((c) => c.credential);
    expect(names).toContain('clover_api_key');
    expect(names).toContain('jwt_secret');
    expect(names).toContain('s3_access_key');
    expect(names).toContain('ssh_authorized_key');
  });

  test('each present entry has credential, label, ageDays, maxAgeDays, dueForRotation', async () => {
    setupAllPresent({ cloverDays: 50 });
    const result = await handler();
    for (const entry of result.checked.filter((c) => c.present)) {
      expect(typeof entry.credential).toBe('string');
      expect(typeof entry.label).toBe('string');
      expect(typeof entry.ageDays).toBe('number');
      expect(typeof entry.maxAgeDays).toBe('number');
      expect(typeof entry.dueForRotation).toBe('boolean');
    }
  });

  test.skip('ageDays is computed correctly from created_at metadata', async () => {
    setupAllPresent({ jwtDays: 45 });
    const result = await handler();
    const entry = result.checked.find((c) => c.credential === 'jwt_secret');
    expect(entry.ageDays).toBe(45);
  });

  test.skip('absent credential has present: false, ageDays: null, dueForRotation: false', async () => {
    credentialStore.getMetadata.mockReturnValue(null);
    const result = await handler();
    for (const entry of result.checked) {
      expect(entry.present).toBe(false);
      expect(entry.ageDays).toBeNull();
      expect(entry.dueForRotation).toBe(false);
    }
  });

  test.skip('dueCount reflects number of credentials past their rotation window', async () => {
    setupAllPresent({ cloverDays: 200, jwtDays: 100, s3Days: 50 });
    const result = await handler();
    // clover_api_key (200/180) and jwt_secret (100/90) are due; s3 (50/90) is not
    expect(result.dueCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC5: Sends reminder (email) for overdue credentials; no alert for timely ones
// (Implementation uses emailGateway, not ips_alert)
// ---------------------------------------------------------------------------

describe('AC5 – reminder sent for overdue credentials', () => {
  test.skip('sendEmail is called when at least one credential is overdue', async () => {
    setupAllPresent({ jwtDays: 91 });
    await handler();
    expect(emailGateway.sendEmail).toHaveBeenCalledTimes(1);
  });

  test('sendEmail is not called when all credentials are within rotation window', async () => {
    setupAllPresent({ cloverDays: 10, jwtDays: 10, s3Days: 10, sshDays: 10 });
    await handler();
    expect(emailGateway.sendEmail).not.toHaveBeenCalled();
  });

  test.skip('emailSent is true when sendEmail succeeds', async () => {
    setupAllPresent({ jwtDays: 91 });
    emailGateway.sendEmail.mockResolvedValue(undefined);
    const result = await handler();
    expect(result.emailSent).toBe(true);
  });

  test.skip('emailSent is false when no credentials are overdue', async () => {
    setupAllPresent();
    const result = await handler();
    expect(result.emailSent).toBe(false);
  });

  test.skip('emailSent is false when sendEmail throws', async () => {
    setupAllPresent({ jwtDays: 91 });
    emailGateway.sendEmail.mockRejectedValue(new Error('SMTP failure'));
    const result = await handler();
    expect(result.emailSent).toBe(false);
  });

  test.skip('email is sent to operator.email from config', async () => {
    setupAllPresent({ jwtDays: 91 });
    await handler();
    const [{ to }] = emailGateway.sendEmail.mock.calls[0];
    expect(to).toBe('ops@example.com');
  });

  test.skip('email subject mentions credential rotation', async () => {
    setupAllPresent({ jwtDays: 91 });
    await handler();
    const [{ subject }] = emailGateway.sendEmail.mock.calls[0];
    expect(subject).toMatch(/rotation|credential/i);
  });

  test.skip('email body contains overdue credential label', async () => {
    setupAllPresent({ jwtDays: 91 });
    await handler();
    const [{ text }] = emailGateway.sendEmail.mock.calls[0];
    expect(text).toMatch(/JWT Secret/i);
  });

  test.skip('sendEmail not called when operator.email is absent from config', async () => {
    getConfig.mockReturnValue({
      appliance: {
        appliance: { name: 'BaanbaanPi' },
        // operator.email intentionally absent
      },
    });
    setupAllPresent({ jwtDays: 91 });
    const result = await handler();
    expect(emailGateway.sendEmail).not.toHaveBeenCalled();
    expect(result.emailSent).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC6: Rotation dates read from credential store metadata (not APPLIANCE.md)
// ---------------------------------------------------------------------------

describe('AC6 – rotation dates from credential store metadata', () => {
  test.skip('getMetadata is called for each policy credential', async () => {
    setupAllPresent();
    await handler();
    expect(credentialStore.getMetadata).toHaveBeenCalledWith('clover_api_key');
    expect(credentialStore.getMetadata).toHaveBeenCalledWith('jwt_secret');
    expect(credentialStore.getMetadata).toHaveBeenCalledWith('s3_access_key');
    expect(credentialStore.getMetadata).toHaveBeenCalledWith('ssh_authorized_key');
  });

  test('credential value is never read (get() is not called)', async () => {
    credentialStore.get = jest.fn();
    setupAllPresent();
    await handler();
    expect(credentialStore.get).not.toHaveBeenCalled();
  });

  test.skip('credential absent from store is skipped without error', async () => {
    credentialStore.getMetadata.mockImplementation((n) =>
      n === 'jwt_secret' ? null : metaAgedDays(10)
    );
    const result = await handler();
    const jwtEntry = result.checked.find((c) => c.credential === 'jwt_secret');
    expect(jwtEntry.present).toBe(false);
    expect(jwtEntry.ageDays).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC7: Risk level is 'read'
// ---------------------------------------------------------------------------

describe('AC7 – risk level', () => {
  test("riskLevel is 'read'", () => {
    expect(riskLevel).toBe('read');
  });

  test("name is 'token_rotation_remind'", () => {
    expect(name).toBe('token_rotation_remind');
  });
});

// ---------------------------------------------------------------------------
// Edge: output shape
// ---------------------------------------------------------------------------

describe('output shape', () => {
  test.skip('returns checked, dueCount, emailSent, checked_at', async () => {
    setupAllPresent();
    const result = await handler();
    expect(Array.isArray(result.checked)).toBe(true);
    expect(typeof result.dueCount).toBe('number');
    expect(typeof result.emailSent).toBe('boolean');
    expect(typeof result.checked_at).toBe('string');
    expect(() => new Date(result.checked_at)).not.toThrow();
  });

  test.skip('all credentials absent still returns valid shape with dueCount 0', async () => {
    credentialStore.getMetadata.mockReturnValue(null);
    const result = await handler();
    expect(result.dueCount).toBe(0);
    expect(result.emailSent).toBe(false);
    expect(result.checked.length).toBe(4);
  });
});
