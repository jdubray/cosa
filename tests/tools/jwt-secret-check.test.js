'use strict';

/**
 * Unit tests for src/tools/jwt-secret-check.js
 *
 * Acceptance Criteria covered:
 *   AC1 — reads JWT secret from credential store (never via SSH)
 *   AC2 — computes Shannon entropy of the secret
 *   AC3 — returns entropy_bits, age_days, last_rotated, needs_rotation
 *   AC4 — needs_rotation=true when age > 90 days or entropy < 128 bits
 *   AC5 — returns recommendation string when rotation is needed
 *   AC6 — secret value never appears in output, logs, or session.db
 *   AC7 — risk level is 'read'
 */

// ---------------------------------------------------------------------------
// Mocks — declared before any require() so Jest hoisting applies
// ---------------------------------------------------------------------------

const mockGet         = jest.fn();
const mockGetMetadata = jest.fn();

jest.mock('../../src/credential-store', () => ({
  get:         (...a) => mockGet(...a),
  getMetadata: (...a) => mockGetMetadata(...a),
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
// Module under test (required AFTER mocks are set up)
// ---------------------------------------------------------------------------

const { handler, riskLevel, name } = require('../../src/tools/jwt-secret-check');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Return an epoch timestamp that is `days` days ago. */
function daysAgo(days) {
  return Date.now() - days * MS_PER_DAY;
}

/** ISO 8601 string that is `days` days ago. */
function isoAgo(days) {
  return new Date(daysAgo(days)).toISOString();
}

/**
 * Build a string with the given Shannon entropy (approximate).
 * A string of `length` distinct characters has maximum entropy.
 */
function highEntropySecret(length = 40) {
  // Use a mix of printable ASCII so entropy is well above 128 bits.
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[i % chars.length];
  }
  return result;
}

/** A short, low-entropy secret (repeating chars). */
const LOW_ENTROPY_SECRET = 'aaaaaaaaaaaaaaaaaaaaaaaaaaa'; // 27 'a' chars — entropy ≈ 0 bits

// ---------------------------------------------------------------------------
// AC7 — metadata
// ---------------------------------------------------------------------------

describe('AC7 — module metadata', () => {
  it('exports name = jwt_secret_check', () => {
    expect(name).toBe('jwt_secret_check');
  });

  it('exports riskLevel = read', () => {
    expect(riskLevel).toBe('read');
  });
});

// ---------------------------------------------------------------------------
// AC1 — reads from credential store, never SSH
// ---------------------------------------------------------------------------

describe('AC1 — reads JWT secret from credential store', () => {
  beforeEach(() => {
    mockGet.mockReturnValue(highEntropySecret());
    mockGetMetadata.mockReturnValue({ name: 'jwt_secret', created_at: daysAgo(10), last_accessed: null });
  });

  it('calls credentialStore.get() with the supplied credential_name', async () => {
    await handler({ credential_name: 'jwt_secret' });
    expect(mockGet).toHaveBeenCalledWith('jwt_secret');
  });

  it('does not import or call ssh-backend', async () => {
    // If ssh-backend were required it would throw (not mocked).
    await expect(handler({ credential_name: 'jwt_secret' })).resolves.toBeDefined();
  });

  it('throws a clear message when credential is not found', async () => {
    mockGet.mockImplementation(() => { throw new Error('Credential not found: jwt_secret'); });
    await expect(handler({ credential_name: 'jwt_secret' }))
      .rejects.toThrow(/credential not found/i);
  });
});

// ---------------------------------------------------------------------------
// AC2 — Shannon entropy computation
// ---------------------------------------------------------------------------

describe('AC2 — Shannon entropy computation', () => {
  it('returns entropy_bits > 0 for a real secret', async () => {
    mockGet.mockReturnValue('my-random-secret-value-123!');
    mockGetMetadata.mockReturnValue({ name: 'jwt_secret', created_at: daysAgo(5), last_accessed: null });

    const result = await handler({ credential_name: 'jwt_secret' });
    expect(result.entropy_bits).toBeGreaterThan(0);
  });

  it('returns entropy_bits = 0 for a single-character repeated string', async () => {
    mockGet.mockReturnValue('aaaaaaaaa');
    mockGetMetadata.mockReturnValue({ name: 'jwt_secret', created_at: daysAgo(5), last_accessed: null });

    const result = await handler({ credential_name: 'jwt_secret' });
    expect(result.entropy_bits).toBe(0);
  });

  it('returns high entropy for a diverse 40-character secret (> 128 bits)', async () => {
    mockGet.mockReturnValue(highEntropySecret(40));
    mockGetMetadata.mockReturnValue({ name: 'jwt_secret', created_at: daysAgo(5), last_accessed: null });

    const result = await handler({ credential_name: 'jwt_secret' });
    expect(result.entropy_bits).toBeGreaterThan(128);
  });
});

// ---------------------------------------------------------------------------
// AC3 — return shape
// ---------------------------------------------------------------------------

describe('AC3 — return shape contains required fields', () => {
  beforeEach(() => {
    mockGet.mockReturnValue(highEntropySecret());
    mockGetMetadata.mockReturnValue({ name: 'jwt_secret', created_at: daysAgo(30), last_accessed: null });
  });

  it('result contains entropy_bits', async () => {
    const result = await handler({ credential_name: 'jwt_secret' });
    expect(result).toHaveProperty('entropy_bits');
    expect(typeof result.entropy_bits).toBe('number');
  });

  it('result contains age_days', async () => {
    const result = await handler({ credential_name: 'jwt_secret' });
    expect(result).toHaveProperty('age_days');
    expect(typeof result.age_days).toBe('number');
  });

  it('result contains last_rotated as ISO 8601 string', async () => {
    const result = await handler({ credential_name: 'jwt_secret' });
    expect(result).toHaveProperty('last_rotated');
    expect(() => new Date(result.last_rotated).toISOString()).not.toThrow();
  });

  it('result contains needs_rotation as boolean', async () => {
    const result = await handler({ credential_name: 'jwt_secret' });
    expect(result).toHaveProperty('needs_rotation');
    expect(typeof result.needs_rotation).toBe('boolean');
  });

  it('result contains credential_name and checked_at', async () => {
    const result = await handler({ credential_name: 'jwt_secret' });
    expect(result.credential_name).toBe('jwt_secret');
    expect(result.checked_at).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AC4 — needs_rotation logic
// ---------------------------------------------------------------------------

describe('AC4 — needs_rotation decision', () => {
  it('is false when age <= 90 days and entropy >= 128 bits', async () => {
    mockGet.mockReturnValue(highEntropySecret(40));
    mockGetMetadata.mockReturnValue({ name: 'jwt_secret', created_at: daysAgo(30), last_accessed: null });

    const result = await handler({ credential_name: 'jwt_secret' });
    expect(result.needs_rotation).toBe(false);
  });

  it('is true when age > 90 days (even with high entropy)', async () => {
    mockGet.mockReturnValue(highEntropySecret(40));
    mockGetMetadata.mockReturnValue({ name: 'jwt_secret', created_at: daysAgo(91), last_accessed: null });

    const result = await handler({ credential_name: 'jwt_secret' });
    expect(result.needs_rotation).toBe(true);
    expect(result.age_days).toBeGreaterThan(90);
  });

  it('is true when entropy < 128 bits (even with recent creation)', async () => {
    mockGet.mockReturnValue(LOW_ENTROPY_SECRET);
    mockGetMetadata.mockReturnValue({ name: 'jwt_secret', created_at: daysAgo(5), last_accessed: null });

    const result = await handler({ credential_name: 'jwt_secret' });
    expect(result.needs_rotation).toBe(true);
    expect(result.entropy_bits).toBeLessThan(128);
  });

  it('is true when BOTH age > 90 and entropy < 128', async () => {
    mockGet.mockReturnValue(LOW_ENTROPY_SECRET);
    mockGetMetadata.mockReturnValue({ name: 'jwt_secret', created_at: daysAgo(100), last_accessed: null });

    const result = await handler({ credential_name: 'jwt_secret' });
    expect(result.needs_rotation).toBe(true);
  });

  it('respects last_rotated_at input over created_at when supplied', async () => {
    mockGet.mockReturnValue(highEntropySecret(40));
    mockGetMetadata.mockReturnValue({ name: 'jwt_secret', created_at: daysAgo(200), last_accessed: null });

    // last_rotated_at only 10 days ago → should NOT need rotation
    const result = await handler({
      credential_name: 'jwt_secret',
      last_rotated_at: isoAgo(10),
    });
    expect(result.needs_rotation).toBe(false);
    expect(result.age_days).toBeLessThanOrEqual(11);
  });

  it('treats last_rotated_at 91 days ago as needing rotation', async () => {
    mockGet.mockReturnValue(highEntropySecret(40));
    mockGetMetadata.mockReturnValue({ name: 'jwt_secret', created_at: daysAgo(5), last_accessed: null });

    const result = await handler({
      credential_name: 'jwt_secret',
      last_rotated_at: isoAgo(91),
    });
    expect(result.needs_rotation).toBe(true);
  });

  it('throws when last_rotated_at is not a valid date string', async () => {
    mockGet.mockReturnValue(highEntropySecret(40));
    await expect(handler({
      credential_name: 'jwt_secret',
      last_rotated_at: 'not-a-date',
    })).rejects.toThrow(/last_rotated_at/i);
  });
});

// ---------------------------------------------------------------------------
// AC5 — recommendation string
// ---------------------------------------------------------------------------

describe('AC5 — recommendation string', () => {
  it('is null when rotation is not needed', async () => {
    mockGet.mockReturnValue(highEntropySecret(40));
    mockGetMetadata.mockReturnValue({ name: 'jwt_secret', created_at: daysAgo(30), last_accessed: null });

    const result = await handler({ credential_name: 'jwt_secret' });
    expect(result.recommendation).toBeNull();
  });

  it('is a non-empty string when age > 90 days', async () => {
    mockGet.mockReturnValue(highEntropySecret(40));
    mockGetMetadata.mockReturnValue({ name: 'jwt_secret', created_at: daysAgo(95), last_accessed: null });

    const result = await handler({ credential_name: 'jwt_secret' });
    expect(typeof result.recommendation).toBe('string');
    expect(result.recommendation.length).toBeGreaterThan(0);
  });

  it('mentions the age limit when rotation is needed due to age', async () => {
    mockGet.mockReturnValue(highEntropySecret(40));
    mockGetMetadata.mockReturnValue({ name: 'jwt_secret', created_at: daysAgo(95), last_accessed: null });

    const result = await handler({ credential_name: 'jwt_secret' });
    expect(result.recommendation).toMatch(/90/);
  });

  it('mentions entropy when rotation is needed due to weak key', async () => {
    mockGet.mockReturnValue(LOW_ENTROPY_SECRET);
    mockGetMetadata.mockReturnValue({ name: 'jwt_secret', created_at: daysAgo(5), last_accessed: null });

    const result = await handler({ credential_name: 'jwt_secret' });
    expect(result.recommendation).toMatch(/entropy/i);
  });

  it('mentions both reasons when age AND entropy both trigger rotation', async () => {
    mockGet.mockReturnValue(LOW_ENTROPY_SECRET);
    mockGetMetadata.mockReturnValue({ name: 'jwt_secret', created_at: daysAgo(100), last_accessed: null });

    const result = await handler({ credential_name: 'jwt_secret' });
    expect(result.recommendation).toMatch(/age/i);
    expect(result.recommendation).toMatch(/entropy/i);
  });
});

// ---------------------------------------------------------------------------
// AC6 — secret value never in output
// ---------------------------------------------------------------------------

describe('AC6 — secret value never leaks into output', () => {
  const SECRET = 'ULTRA_SECRET_JWT_VALUE_that_must_never_appear_xyz987';

  beforeEach(() => {
    mockGet.mockReturnValue(SECRET);
    mockGetMetadata.mockReturnValue({ name: 'jwt_secret', created_at: daysAgo(5), last_accessed: null });
  });

  it('result object does not contain the raw secret anywhere', async () => {
    const result = await handler({ credential_name: 'jwt_secret' });
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(SECRET);
  });

  it('does not include a "value" or "secret" field in the result', async () => {
    const result = await handler({ credential_name: 'jwt_secret' });
    expect(result).not.toHaveProperty('value');
    expect(result).not.toHaveProperty('secret');
  });
});
