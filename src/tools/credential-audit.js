'use strict';

const sshBackend       = require('../ssh-backend');
const { getConfig }    = require('../../config/cosa.config');
const { isSuppressionActive } = require('../session-store');
const { createLogger } = require('../logger');

const log = createLogger('credential-audit');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME       = 'credential_audit';
const RISK_LEVEL = 'read';

// Default path to the git working tree on the remote appliance.
// Override via tools.credential_audit.repo_path in appliance.yaml.
const DEFAULT_REPO_PATH = '/home/baanbaan/baan-baan-merchant/v2';

const INPUT_SCHEMA = {
  type:                 'object',
  properties:           {},
  required:             [],
  additionalProperties: false,
};

const SCHEMA = {
  description:
    'Scan the Baanbaan git working tree for accidentally committed credentials. ' +
    'Searches tracked .ts, .js, .json, .env, .yaml, .yml files via git grep over SSH. ' +
    'Detects Clover live keys (sk_live_*), AWS access keys (AKIA*), base64-encoded ' +
    'secrets, and password= patterns. Checks .gitignore coverage for .env and secrets ' +
    'directories. Returns a findings array (file, line, pattern, severity, snippet) and ' +
    'a gitignoreCoverage object.',
  inputSchema: INPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Credential patterns
//
// All patterns are static constants — never constructed from user input.
// git grep uses POSIX extended regex (-E).
// ---------------------------------------------------------------------------

/** @type {Array<{ name: string, grepRegex: string, severity: string, description: string }>} */
const PATTERNS = [
  {
    name:        'clover_live_key',
    grepRegex:   'sk_live_[A-Za-z0-9_]+',
    severity:    'critical',
    description: 'Clover live payment secret key (sk_live_*)',
  },
  {
    name:        'aws_access_key',
    grepRegex:   'AKIA[0-9A-Z]{16}',
    severity:    'critical',
    description: 'AWS access key ID (AKIA[0-9A-Z]{16})',
  },
  {
    name:        'base64_secret',
    grepRegex:   '(secret|password|token|auth|key)[^=]*=[[:space:]]*[A-Za-z0-9+/]{40,}={0,2}',
    severity:    'high',
    description: 'Possible base64-encoded secret value',
  },
  {
    name:        'password_assignment',
    grepRegex:   'password[[:space:]]*[=:][[:space:]]*[^[:space:]]{4,}',
    severity:    'high',
    description: 'Plain-text password assignment',
  },
];

// Tracked file extensions to search (AC1).
// Passed as shell-quoted pathspecs after `-- ` in git grep.
const FILE_PATHSPECS = "'*.ts' '*.js' '*.json' '*.yaml' '*.yml' '*.env' '.env'";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse git grep output lines into structured records.
 *
 * git grep -n output format:
 *   <filepath>:<linenum>:<matched line content>
 *
 * @param {string} stdout
 * @returns {Array<{ file: string, line: number, content: string }>}
 */
function parseGrepOutput(stdout) {
  const results = [];
  for (const raw of stdout.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const firstColon  = trimmed.indexOf(':');
    if (firstColon === -1) continue;
    const secondColon = trimmed.indexOf(':', firstColon + 1);
    if (secondColon === -1) continue;

    const file    = trimmed.slice(0, firstColon);
    const lineNum = parseInt(trimmed.slice(firstColon + 1, secondColon), 10);
    const content = trimmed.slice(secondColon + 1);

    if (!file || isNaN(lineNum)) continue;
    results.push({ file, line: lineNum, content });
  }
  return results;
}

/**
 * Produce a redacted version of a matched source line suitable for reporting.
 * Secret values are replaced with [REDACTED]; surrounding context is preserved.
 * Output is capped at 120 characters.
 *
 * @param {string}  content     - Raw matched line from git grep.
 * @param {string}  patternName - One of the PATTERNS[].name values.
 * @returns {string}
 */
function redactSnippet(content, patternName) {
  const trimmed = content.trim();
  let redacted;

  switch (patternName) {
    case 'clover_live_key':
      redacted = trimmed.replace(/(sk_live_)[A-Za-z0-9_]+/gi, '$1[REDACTED]');
      break;

    case 'aws_access_key':
      // Keep the first 8 chars (AKIA + 4) so the key prefix is visible for
      // correlation while the secret suffix is hidden.
      redacted = trimmed.replace(/(AKIA[0-9A-Z]{4})[0-9A-Z]{12}/g, '$1[REDACTED]');
      break;

    case 'base64_secret':
      // Keep the first 10 chars of any long base64 run; redact the rest.
      redacted = trimmed.replace(
        /([A-Za-z0-9+/]{10})[A-Za-z0-9+/]{30,}={0,2}/g,
        '$1[REDACTED]'
      );
      break;

    case 'password_assignment':
      // Keep up to the delimiter (= or :) and redact the value.
      redacted = trimmed.replace(
        /(password\s*[=:]\s*)\S{4,}/gi,
        '$1[REDACTED]'
      );
      break;

    default:
      redacted = trimmed;
  }

  return redacted.slice(0, 120);
}

/**
 * Fetch and parse the .gitignore file from the remote repo.
 * Tries `git show HEAD:.gitignore` first (committed), then falls back to
 * `cat <repoPath>/.gitignore` (working-tree only).
 *
 * @param {string} repoPath - Absolute path to the git repo on the remote host.
 * @returns {Promise<{ coversEnv: boolean, coversSecrets: boolean, raw: string }>}
 */
async function fetchGitignoreCoverage(repoPath) {
  // Both commands are static strings that only embed the operator-configured repoPath.
  const cmd = `git -C '${repoPath}' show HEAD:.gitignore 2>/dev/null ` +
              `|| cat '${repoPath}/.gitignore' 2>/dev/null ` +
              `|| echo ''`;

  const result = await sshBackend.exec(cmd);
  const raw    = result.stdout || '';

  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  // AC5: .env coverage — matches `.env`, `*.env`, `.env*`, or `**/.env`
  const coversEnv = lines.some((l) =>
    /^\.env$/.test(l)     ||
    /^\*\.env$/.test(l)   ||
    /^\.env\*$/.test(l)   ||
    /\/\.env$/.test(l)
  );

  // AC5: secrets directory coverage — matches `secrets`, `secrets/`, `/secrets`, etc.
  const coversSecrets = lines.some((l) =>
    /^secrets\/?$/.test(l)  ||
    /^\/secrets\/?$/.test(l) ||
    /^secrets\/\*/.test(l)
  );

  return { coversEnv, coversSecrets, raw };
}

// ---------------------------------------------------------------------------
// Suppression helpers
// ---------------------------------------------------------------------------

/**
 * Build a stable fingerprint for a finding.
 * Format: `<pattern>:<file>:<line>` — e.g. `aws_access_key:test/backup.test.ts:270`
 *
 * @param {{ pattern: string, file: string, line: number }} finding
 * @returns {string}
 */
function fingerprintFinding(finding) {
  return `${finding.pattern}:${finding.file}:${finding.line}`;
}

/**
 * Return true if this finding is suppressed either in the DB or via the
 * static `tools.credential_audit.suppressed_findings` list in appliance.yaml.
 *
 * Static config supports three match modes (pattern must match in all cases):
 *   1. Exact tuple — `{ pattern, file, line }` matches a single finding.
 *   2. Whole-file — `{ pattern, file }` (line omitted) matches every finding
 *      of `pattern` in that exact file.
 *   3. Directory prefix — `{ pattern, file }` where `file` ends with `/`
 *      matches every finding of `pattern` whose path starts with `file`.
 *
 * Example (appliance.yaml):
 *   tools:
 *     credential_audit:
 *       suppressed_findings:
 *         - pattern: aws_access_key
 *           file: test/backup.test.ts
 *           line: 270
 *           reason: canonical AWS docs example key
 *         - pattern: password_assignment
 *           file: test/
 *           reason: unit test fixtures, never live
 *
 * @param {{ pattern: string, file: string, line: number }} finding
 * @param {Array<{ pattern: string, file: string, line?: number }>} staticList
 * @returns {boolean}
 */
function _isSuppressed(finding, staticList) {
  const fp = fingerprintFinding(finding);

  // DB check first.
  try {
    if (isSuppressionActive(fp)) return true;
  } catch {
    // session.db unavailable — fall through to static check.
  }

  return staticList.some((s) => {
    if (s.pattern !== finding.pattern) return false;
    if (typeof s.file !== 'string' || !s.file) return false;

    // Directory-prefix match: entry file ends with '/'.
    if (s.file.endsWith('/')) {
      return finding.file.startsWith(s.file);
    }

    // Exact file path required from here.
    if (s.file !== finding.file) return false;

    // Line omitted → whole-file suppression.
    if (s.line == null) return true;

    // Explicit line → exact-line suppression.
    return Number(s.line) === finding.line;
  });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{
 *   summary: string,
 *   findings: Array<{
 *     file: string, line: number, pattern: string,
 *     severity: string, description: string, snippet: string
 *   }>,
 *   gitignoreCoverage: { coversEnv: boolean, coversSecrets: boolean },
 *   totalFindingCount: number,
 *   checked_at: string
 * }>}
 */
async function handler() {
  const checked_at = new Date().toISOString();

  if (!sshBackend.isConnected()) {
    throw new Error('SSH not connected — cannot run credential audit');
  }

  const { appliance } = getConfig();
  const toolCfg       = appliance.tools?.credential_audit ?? {};
  const repoPath      = toolCfg.repo_path ?? DEFAULT_REPO_PATH;
  const staticSuppressions = Array.isArray(toolCfg.suppressed_findings)
    ? toolCfg.suppressed_findings
    : [];

  log.info(`Starting credential audit on repo: ${repoPath}`);

  // ── 1. Run git grep for each pattern ──────────────────────────────────────

  /** @type {Array<{ file, line, pattern, severity, description, snippet }>} */
  const findings = [];

  for (const pattern of PATTERNS) {
    // Static command — repoPath is operator config, grepRegex is a hardcoded constant.
    const cmd = `git -C '${repoPath}' grep -n -E '${pattern.grepRegex}' -- ${FILE_PATHSPECS} 2>/dev/null`;

    log.debug(`Running git grep for pattern: ${pattern.name}`);
    const result = await sshBackend.exec(cmd);

    // git grep exits 1 when there are no matches (not an error).
    // Exit > 1 means a real error (repo not found, etc.).
    if (result.exitCode > 1) {
      log.warn(
        `git grep for '${pattern.name}' exited ${result.exitCode}: ${result.stderr?.trim()}`
      );
      continue;
    }

    if (result.exitCode === 1) {
      // No matches for this pattern — expected, continue.
      continue;
    }

    const matches = parseGrepOutput(result.stdout);
    log.info(`Pattern '${pattern.name}': ${matches.length} match(es)`);

    for (const match of matches) {
      findings.push({
        file:        match.file,
        line:        match.line,
        pattern:     pattern.name,
        severity:    pattern.severity,
        description: pattern.description,
        snippet:     redactSnippet(match.content, pattern.name),
        fingerprint: fingerprintFinding({ pattern: pattern.name, file: match.file, line: match.line }),
      });
    }
  }

  // ── 1b. Filter suppressed findings ────────────────────────────────────────

  const suppressed = findings.filter((f) => _isSuppressed(f, staticSuppressions));
  const active     = findings.filter((f) => !_isSuppressed(f, staticSuppressions));

  if (suppressed.length > 0) {
    log.info(
      `Suppressed ${suppressed.length} known finding(s): ` +
      suppressed.map((f) => f.fingerprint).join(', ')
    );
  }

  // ── 2. Check .gitignore coverage ──────────────────────────────────────────

  log.info('Checking .gitignore coverage');
  const { coversEnv, coversSecrets } = await fetchGitignoreCoverage(repoPath);

  const gitignoreCoverage = { coversEnv, coversSecrets };

  // ── 3. Build summary ───────────────────────────────────────────────────────

  const criticalCount = active.filter((f) => f.severity === 'critical').length;
  const highCount     = active.filter((f) => f.severity === 'high').length;

  const coverageIssues = [];
  if (!coversEnv)     coverageIssues.push('.env not covered by .gitignore');
  if (!coversSecrets) coverageIssues.push('secrets/ not covered by .gitignore');

  let summary;
  if (active.length === 0 && coverageIssues.length === 0) {
    summary = 'No credential exposures detected. .gitignore coverage is adequate.';
  } else {
    const parts = [];
    if (criticalCount > 0) parts.push(`${criticalCount} critical finding(s)`);
    if (highCount > 0)     parts.push(`${highCount} high finding(s)`);
    if (coverageIssues.length > 0) parts.push(coverageIssues.join('; '));
    summary = parts.join('. ') + '.';
  }

  log.info(
    `Credential audit complete: ${active.length} active finding(s), ` +
    `${suppressed.length} suppressed, ` +
    `coversEnv=${coversEnv}, coversSecrets=${coversSecrets}`
  );

  return {
    summary,
    findings:          active,
    suppressedFindings: suppressed,
    gitignoreCoverage,
    totalFindingCount: active.length,
    checked_at,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
