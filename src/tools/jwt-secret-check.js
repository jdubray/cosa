'use strict';

const credentialStore = require('../credential-store');
const { createLogger } = require('../logger');

const log = createLogger('jwt-secret-check');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME       = 'jwt_secret_check';
const RISK_LEVEL = 'read';

/** Rotation is required if the secret is older than this many days. */
const MAX_AGE_DAYS      = 90;
/** Rotation is required if Shannon entropy is below this many bits. */
const MIN_ENTROPY_BITS  = 128;

const INPUT_SCHEMA = {
  type:                 'object',
  properties: {
    credential_name: {
      type:        'string',
      description:
        'Symbolic name of the JWT secret in the credential store ' +
        '(e.g. "jwt_secret"). The value is never transmitted over SSH.',
    },
    last_rotated_at: {
      type:        'string',
      description:
        'ISO 8601 date-time of the last known rotation ' +
        '(e.g. "2024-10-01T00:00:00Z"). ' +
        'When omitted, the credential store creation timestamp is used.',
    },
  },
  required:             ['credential_name'],
  additionalProperties: false,
};

const SCHEMA = {
  description:
    'Check the entropy and rotation age of the JWT secret stored in the ' +
    'COSA credential store. Returns entropyBits, ageDays, lastRotated, and ' +
    'needsRotation. Rotation is recommended when age > 90 days or ' +
    'entropy < 128 bits. The secret value is never included in output or logs.',
  inputSchema: INPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Entropy helpers
// ---------------------------------------------------------------------------

/**
 * Compute the total Shannon entropy of a string in bits.
 *
 * Uses per-character (code-point) frequency distribution.
 * For a uniformly random secret of length n the result approaches n * log2(alphabet).
 *
 * @param {string} secret
 * @returns {number} Total entropy in bits (rounded to 2 decimal places).
 */
function shannonEntropyBits(secret) {
  if (!secret || secret.length === 0) return 0;

  const freq = {};
  for (let i = 0; i < secret.length; i++) {
    const ch = secret[i];
    freq[ch] = (freq[ch] || 0) + 1;
  }

  let bitsPerChar = 0;
  for (const count of Object.values(freq)) {
    const p = count / secret.length;
    bitsPerChar -= p * Math.log2(p);
  }

  return Math.round(bitsPerChar * secret.length * 100) / 100;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @param {{ credential_name: string, last_rotated_at?: string }} input
 * @returns {Promise<object>}
 */
async function handler({ credential_name, last_rotated_at }) {
  const checkedAt = new Date().toISOString();

  // ── Retrieve secret from credential store (never via SSH) ──────────────────
  let secret;
  try {
    secret = credentialStore.get(credential_name);
  } catch (err) {
    // Propagate "not found" clearly; no secret value is in the message.
    throw new Error(
      `JWT secret check failed — credential not found: "${credential_name}". ` +
      'Store it with: node src/main.js credentials set <name> <value>'
    );
  }

  // ── Entropy ────────────────────────────────────────────────────────────────
  const entropyBits = shannonEntropyBits(secret);

  // Immediately discard the secret; nothing below this line uses it.
  secret = null; // eslint-disable-line no-param-reassign

  // ── Rotation age ───────────────────────────────────────────────────────────
  let lastRotatedEpoch;

  if (last_rotated_at) {
    const parsed = Date.parse(last_rotated_at);
    if (isNaN(parsed)) {
      throw new Error(
        `Invalid last_rotated_at value: "${last_rotated_at}". ` +
        'Expected an ISO 8601 date-time string.'
      );
    }
    lastRotatedEpoch = parsed;
  } else {
    // Fall back to the credential store creation timestamp.
    const meta = credentialStore.getMetadata(credential_name);
    // meta will never be null here — we already confirmed get() succeeded above.
    lastRotatedEpoch = meta.created_at;
    log.debug(
      `No last_rotated_at supplied for "${credential_name}"; ` +
      'using credential store created_at as rotation reference.'
    );
  }

  const nowMs    = Date.now();
  const ageDays  = Math.floor((nowMs - lastRotatedEpoch) / (1000 * 60 * 60 * 24));
  const lastRotated = new Date(lastRotatedEpoch).toISOString();

  // ── Rotation decision ──────────────────────────────────────────────────────
  const tooOld   = ageDays > MAX_AGE_DAYS;
  const weakKey  = entropyBits < MIN_ENTROPY_BITS;
  const needsRotation = tooOld || weakKey;

  const reasons = [];
  if (tooOld)  reasons.push(`age ${ageDays} days exceeds the ${MAX_AGE_DAYS}-day limit`);
  if (weakKey) reasons.push(`entropy ${entropyBits} bits is below the ${MIN_ENTROPY_BITS}-bit minimum`);

  const recommendation = needsRotation
    ? `Rotate the JWT secret immediately: ${reasons.join('; ')}.`
    : null;

  // Log only the symbolic name and derived metrics — never the secret value.
  log.info(
    `JWT secret check for "${credential_name}": ` +
    `entropyBits=${entropyBits}, ageDays=${ageDays}, needsRotation=${needsRotation}`
  );

  return {
    credential_name,
    entropy_bits:    entropyBits,
    age_days:        ageDays,
    last_rotated:    lastRotated,
    needs_rotation:  needsRotation,
    recommendation,
    checked_at:      checkedAt,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
