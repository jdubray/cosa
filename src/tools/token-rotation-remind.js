'use strict';

const toolRegistry     = require('../tool-registry');
const { getConfig }    = require('../../config/cosa.config');
const { createLogger } = require('../logger');

const log = createLogger('token-rotation-remind');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME       = 'token_rotation_remind';
const RISK_LEVEL = 'read';

/**
 * Rotation policy (in days).
 *
 * configKey: the key under appliance.compliance that holds the last-rotation
 * date string (YYYY-MM-DD or ISO 8601).  Per AC6, rotation dates are read
 * from APPLIANCE.md (via the appliance config), NOT from the credential store.
 */
const ROTATION_POLICIES = [
  {
    name:      'clover_api_key',
    label:     'Clover API Key',
    maxAgeDays: 180,
    configKey: 'clover_token_last_rotated',
  },
  {
    name:      'jwt_secret',
    label:     'JWT Secret',
    maxAgeDays: 90,
    configKey: 'jwt_secret_last_rotated',
  },
  {
    name:      's3_access_key',
    label:     'S3 Access Key',
    maxAgeDays: 90,
    configKey: 's3_access_key_last_rotated',
  },
  {
    name:      'ssh_authorized_key',
    label:     'SSH Authorized Keys',
    maxAgeDays: 365,
    configKey: 'ssh_key_last_reviewed',
  },
];

const INPUT_SCHEMA = {
  type:                 'object',
  properties:           {},
  required:             [],
  additionalProperties: false,
};

const SCHEMA = {
  description:
    'Check whether Clover API tokens and other rotatable credentials are due ' +
    'for rotation. Rotation dates are read from APPLIANCE.md (appliance.compliance.*). ' +
    'Rotation policy: Clover API key (6 months), JWT secret (90 days), ' +
    'S3 access key (90 days), SSH authorized keys (annual review). ' +
    'Credentials with no rotation date configured are skipped with a warning. ' +
    'Sends an ips_alert at severity "low" for any overdue credential. ' +
    'Returns a checked array and dueCount.',
  inputSchema: INPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{
 *   checked: Array<{
 *     credential:     string,
 *     label:          string,
 *     configured:     boolean,
 *     lastRotated:    string | null,
 *     ageDays:        number | null,
 *     daysUntilDue:   number | null,
 *     maxAgeDays:     number,
 *     dueForRotation: boolean,
 *   }>,
 *   dueCount:    number,
 *   alertSent:   boolean,
 *   checked_at:  string,
 * }>}
 */
async function handler() {
  const checked_at = new Date().toISOString();

  const { appliance } = getConfig();
  const compliance     = appliance.compliance ?? {};

  // ── 1. Read rotation dates from APPLIANCE.md (AC6) ────────────────────────
  const checked  = [];
  const dueItems = [];

  for (const policy of ROTATION_POLICIES) {
    const dateStr = compliance[policy.configKey] ?? null;

    if (!dateStr) {
      log.warn(
        `token_rotation_remind: "${policy.name}" — no rotation date configured ` +
        `(appliance.compliance.${policy.configKey} is absent) — skipping`
      );
      checked.push({
        credential:     policy.name,
        label:          policy.label,
        configured:     false,
        lastRotated:    null,
        ageDays:        null,
        daysUntilDue:   null,
        maxAgeDays:     policy.maxAgeDays,
        dueForRotation: false,
      });
      continue;
    }

    const lastRotatedMs  = new Date(dateStr).getTime();
    const ageDays        = Math.floor((Date.now() - lastRotatedMs) / (1000 * 60 * 60 * 24));
    const daysUntilDue   = policy.maxAgeDays - ageDays;
    const dueForRotation = ageDays >= policy.maxAgeDays;

    log.info(
      `token_rotation_remind: "${policy.name}" ageDays=${ageDays} ` +
      `maxAgeDays=${policy.maxAgeDays} dueForRotation=${dueForRotation}`
    );

    checked.push({
      credential:     policy.name,
      label:          policy.label,
      configured:     true,
      lastRotated:    new Date(lastRotatedMs).toISOString(),
      ageDays,
      daysUntilDue,
      maxAgeDays:     policy.maxAgeDays,
      dueForRotation,
    });

    if (dueForRotation) {
      dueItems.push({ label: policy.label, ageDays, maxAgeDays: policy.maxAgeDays, lastRotated: dateStr });
    }
  }

  // ── 2. Send ips_alert at severity 'low' for overdue credentials (AC5) ─────
  let alertSent = false;

  if (dueItems.length > 0) {
    const evidence = dueItems.map(
      (item) =>
        `${item.label}: last rotated ${item.lastRotated}, ` +
        `${item.ageDays} days old (limit: ${item.maxAgeDays} days, ` +
        `overdue by ${item.ageDays - item.maxAgeDays} day(s))`
    );

    try {
      await toolRegistry.dispatch('ips_alert', {
        severity:            'low',
        incidentType:        `Credential rotation due: ${dueItems.map((i) => i.label).join(', ')}`,
        evidence,
        actionsAlreadyTaken: 'None — this is a scheduled rotation reminder.',
        responseOptions:     ['ROTATED — reply once credentials have been rotated'],
        autoExpireMinutes:   10080, // 7 days
      });
      alertSent = true;
      log.info(
        `token_rotation_remind: ips_alert dispatched for ${dueItems.length} overdue credential(s)`
      );
    } catch (err) {
      if (err.code !== 'TOOL_NOT_FOUND') {
        log.warn(`token_rotation_remind: ips_alert dispatch failed — ${err.message}`);
      }
    }
  } else {
    log.info('token_rotation_remind: all credentials within rotation window — no alert sent');
  }

  return {
    checked,
    dueCount:  dueItems.length,
    alertSent,
    checked_at,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
