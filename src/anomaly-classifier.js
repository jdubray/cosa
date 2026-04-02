'use strict';

const { createLogger } = require('./logger');
const log = createLogger('anomaly-classifier');

// ---------------------------------------------------------------------------
// Severity helpers
// ---------------------------------------------------------------------------

/** Canonical severity levels in ascending order. */
const SEVERITY_LEVELS = ['clean', 'low', 'medium', 'high', 'critical'];

/**
 * Return the highest severity from an array of severity strings.
 * Unknown or falsy values are ignored.
 *
 * @param {string[]} severities
 * @returns {'clean'|'low'|'medium'|'high'|'critical'}
 */
function highestSeverity(severities) {
  if (severities.includes('critical')) return 'critical';
  if (severities.includes('high'))     return 'high';
  if (severities.includes('medium'))   return 'medium';
  if (severities.includes('low'))      return 'low';
  return 'clean';
}

// ---------------------------------------------------------------------------
// Known false-positive process patterns
// Processes whose command matches any of these patterns are logged but their
// severity is suppressed — they are expected operational noise.
// ---------------------------------------------------------------------------

const FALSE_POSITIVE_COMMANDS = [
  { pattern: /\bpm2\b/i,       label: 'pm2 process manager (restart)' },
  { pattern: /certbot/i,       label: 'certbot (cert renewal)'         },
  { pattern: /acme\.sh/i,      label: 'acme.sh (cert renewal)'         },
  { pattern: /letsencrypt/i,   label: "Let's Encrypt (cert renewal)"   },
];

// ---------------------------------------------------------------------------
// Per-tool severity extractors
// Each extractor receives the tool-output data (everything in the report
// except the `source` key) and returns an array of severity strings.
// ---------------------------------------------------------------------------

/**
 * git_audit, process_monitor, network_scan, access_log_scan all set a
 * top-level `.severity` field in their output.  If a `.findings` array is
 * also present each entry's `.severity` is considered so that future richer
 * output is handled automatically.
 *
 * @param {object} data
 * @returns {string[]}
 */
function extractTopLevelSeverity(data) {
  const result = [];
  if (typeof data.severity === 'string') result.push(data.severity);
  if (Array.isArray(data.findings)) {
    for (const f of data.findings) {
      if (typeof f.severity === 'string') result.push(f.severity);
    }
  }
  return result;
}

/**
 * process_monitor returns `{ unknown_processes: Array<{ user, pid, command, severity }>, ... }`.
 *
 * Each entry's severity is included unless the process command matches a known
 * false-positive pattern (e.g. pm2, certbot), in which case it is logged and
 * skipped so that routine operational restarts do not trigger alerts.
 *
 * @param {object} data
 * @returns {string[]}
 */
function extractProcessMonitor(data) {
  if (!Array.isArray(data.unknown_processes)) return [];
  const severities = [];
  for (const proc of data.unknown_processes) {
    const command = proc.command ?? '';
    const fp = FALSE_POSITIVE_COMMANDS.find(({ pattern }) => pattern.test(command));
    if (fp) {
      log.info(
        `Known false positive suppressed: ${fp.label} ` +
        `(pid=${proc.pid ?? 'unknown'}, cmd=${command.slice(0, 80)})`
      );
      continue;
    }
    if (typeof proc.severity === 'string') severities.push(proc.severity);
  }
  return severities;
}

/**
 * access_log_scan returns `{ anomalies: Array<{ type, severity, ... }>, ... }`.
 * Each anomaly's severity is included in the result set.
 *
 * @param {object} data
 * @returns {string[]}
 */
function extractAccessLogScan(data) {
  if (!Array.isArray(data.anomalies)) return [];
  return data.anomalies.map((a) => a.severity).filter(Boolean);
}

/**
 * credential_audit returns `{ findings: Array<{ severity, ... }> }`.
 * Severity is the highest finding severity, or 'clean' if empty.
 *
 * @param {object} data
 * @returns {string[]}
 */
function extractCredentialAudit(data) {
  if (!Array.isArray(data.findings) || data.findings.length === 0) return [];
  return data.findings.map(f => f.severity).filter(Boolean);
}

/**
 * pci_assessment returns `{ overallStatus: 'compliant'|'needs_review'|'non_compliant', ... }`.
 *
 * @param {object} data
 * @returns {string[]}
 */
function extractPciAssessment(data) {
  switch (data.overallStatus) {
    case 'compliant':     return ['clean'];
    case 'needs_review':  return ['medium'];
    case 'non_compliant': return ['high'];
    default:              return [];
  }
}

/**
 * jwt_secret_check returns `{ needsRotation: boolean, entropyBits: number, ... }`.
 * - entropyBits < 64  → high (weak secret)
 * - needsRotation     → medium (age-based)
 *
 * @param {object} data
 * @returns {string[]}
 */
function extractJwtSecretCheck(data) {
  const result = [];
  if (typeof data.entropyBits === 'number' && data.entropyBits < 64) result.push('high');
  if (data.needsRotation === true) result.push('medium');
  return result;
}

/**
 * webhook_hmac_verify probes the appliance with an invalid HMAC and checks
 * the response status.  The tool returns `{ invalidHmacStatus: number, ... }`.
 * - 401 (rejected)  → clean (HMAC enforcement working)
 * - anything else   → critical (HMAC enforcement bypassed)
 *
 * @param {object} data
 * @returns {string[]}
 */
function extractWebhookHmacVerify(data) {
  if (data.invalidHmacStatus === 401) return ['clean'];
  if (typeof data.invalidHmacStatus === 'number') return ['critical'];
  // If the field is absent (probe failed to reach endpoint) treat as unknown.
  return [];
}

/**
 * token_rotation_remind returns `{ overdueCredentials: string[], ... }`.
 * Any overdue credential → medium.
 *
 * @param {object} data
 * @returns {string[]}
 */
function extractTokenRotationRemind(data) {
  if (Array.isArray(data.overdueCredentials) && data.overdueCredentials.length > 0) {
    return ['medium'];
  }
  return [];
}

/**
 * compliance_verify returns `{ status: 'pass'|'fail'|'warning', ... }`.
 * - pass    → clean
 * - warning → medium
 * - fail    → high
 *
 * @param {object} data
 * @returns {string[]}
 */
function extractComplianceVerify(data) {
  switch (data.status) {
    case 'pass':    return ['clean'];
    case 'warning': return ['medium'];
    case 'fail':    return ['high'];
    default:        return [];
  }
}

// ---------------------------------------------------------------------------
// Extractor dispatch table
// ---------------------------------------------------------------------------

const EXTRACTORS = {
  git_audit:            extractTopLevelSeverity,
  process_monitor:      extractProcessMonitor,
  network_scan:         extractTopLevelSeverity,
  access_log_scan:      extractAccessLogScan,
  credential_audit:     extractCredentialAudit,
  pci_assessment:       extractPciAssessment,
  jwt_secret_check:     extractJwtSecretCheck,
  webhook_hmac_verify:  extractWebhookHmacVerify,
  token_rotation_remind: extractTokenRotationRemind,
  compliance_verify:    extractComplianceVerify,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify an anomaly report from a COSA security tool.
 *
 * The report must have a `source` property identifying which tool produced it;
 * all remaining properties are the tool's own output fields.
 *
 * Action tools (`cloudflare_kill`, `pause_appliance`, `ips_alert`) are not
 * classification sources — they return `'clean'` when passed here.
 *
 * @param {{ source: string, [key: string]: unknown }} report
 * @returns {'clean'|'low'|'medium'|'high'|'critical'}
 */
function classifyAnomaly(report) {
  if (!report || typeof report.source !== 'string') return 'clean';

  const { source, ...data } = report;
  const extractor = EXTRACTORS[source];
  if (!extractor) return 'clean';

  const severities = extractor(data);
  return highestSeverity(severities.filter(s => SEVERITY_LEVELS.includes(s)));
}

module.exports = { classifyAnomaly };
