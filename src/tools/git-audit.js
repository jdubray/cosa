'use strict';

const sshBackend       = require('../ssh-backend');
const { getConfig }    = require('../../config/cosa.config');
const { createLogger } = require('../logger');

const log = createLogger('git-audit');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME       = 'git_audit';
const RISK_LEVEL = 'read';

/** Default lookback window in hours. */
const DEFAULT_LOOKBACK_HOURS = 8;

/**
 * Suspicious keywords in commit subjects that indicate potential code injection.
 * Static list — never constructed from user input.
 */
const SUSPICIOUS_SUBJECT_PATTERNS = [
  /\beval\b/i,
  /\bexec\b/i,
  /\bbase64\b/i,
];

/** Branches considered protected — force-pushes here escalate to 'high'. */
const PROTECTED_BRANCHES = ['main', 'master'];

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    repoPath: {
      type:        'string',
      description: 'Absolute path to the git repository on the remote appliance.',
    },
    lookbackHours: {
      type:        'number',
      description: 'How many hours of git history to inspect (default 8).',
    },
    expectedAuthors: {
      type:        'array',
      items:       { type: 'string' },
      description: 'List of authorised committer email addresses.',
    },
  },
  required:             ['repoPath', 'expectedAuthors'],
  additionalProperties: false,
};

const SCHEMA = {
  description:
    'Inspect recent git commit history on the remote appliance for security anomalies: ' +
    'unauthorized authors, force-pushes on protected branches, suspicious commit subjects ' +
    '(eval/exec/base64 keywords), and unexpected branch refs. ' +
    'Returns a list of commits with individual flags plus an aggregate severity.',
  inputSchema: INPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Log-line parsing
// ---------------------------------------------------------------------------

/**
 * Parse a single pipe-delimited git log line produced by
 * `--pretty=format:"%H|%ae|%ai|%s|%D"`.
 *
 * Fields: hash | authorEmail | isoDate | subject | decorations
 *
 * @param {string} line
 * @returns {{ hash: string, author: string, timestamp: string,
 *             subject: string, refs: string } | null}
 */
function parseLogLine(line) {
  const parts = line.split('|');
  if (parts.length < 4) return null;

  const [hash, author, timestamp, ...rest] = parts;
  if (!hash || !author) return null;

  // Subject may contain '|' characters — everything up to the last field
  // that looks like a git decoration (HEAD ->, origin/, tag:) is subject.
  // Simpler: join everything from index 3, then strip the final decoration.
  // We split at most 4 times so refs is the last segment.
  const joined = rest.join('|');
  // Find the last '|' boundary that precedes a decoration-like string.
  // Since we told git to emit exactly 5 fields, the last pipe is the subject/refs boundary.
  // However subjects can themselves contain pipes, so we must recover refs from the end.
  // git %D can be empty string; we split on the *last* pipe to recover it.
  const lastPipe = joined.lastIndexOf('|');
  let subject, refs;
  if (lastPipe === -1) {
    subject = joined;
    refs    = '';
  } else {
    subject = joined.slice(0, lastPipe);
    refs    = joined.slice(lastPipe + 1);
  }

  return {
    hash:      hash.trim(),
    author:    author.trim(),
    timestamp: timestamp.trim(),
    subject:   subject.trim(),
    refs:      refs.trim(),
  };
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/**
 * Return true if the commit subject contains any suspicious keyword.
 *
 * @param {string} subject
 * @returns {boolean}
 */
function isSuspiciousSubject(subject) {
  return SUSPICIOUS_SUBJECT_PATTERNS.some((re) => re.test(subject));
}

/**
 * Extract branch names from the git decoration string (%D).
 * Examples:
 *   "HEAD -> main, origin/main"          → ['main', 'origin/main']
 *   "tag: v1.2.3"                         → []  (tags ignored)
 *   ""                                    → []
 *
 * @param {string} refs
 * @returns {string[]}
 */
function extractBranches(refs) {
  if (!refs) return [];
  return refs
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r && !r.startsWith('tag:'))
    .map((r) => r.replace(/^HEAD\s*->\s*/, '').trim())
    .filter(Boolean);
}

/**
 * Determine whether the refs string contains evidence of a force-push on a
 * protected branch.  git log itself cannot directly detect force-pushes, but
 * when `--all` is used the presence of a remote-tracking ref diverging from
 * its local counterpart with the commit appearing in reflog is indicative.
 *
 * For COSA's purposes we use the heuristic: if the decorations string
 * contains "force" or the subject contains "force push" / "force-push".
 * A more reliable signal would come from the reflog, but that requires an
 * additional SSH call; for the Phase-3 spec we match the spec exactly.
 *
 * @param {string} subject
 * @param {string} refs
 * @returns {boolean}
 */
function looksLikeForcePush(subject, refs) {
  const haystack = `${subject} ${refs}`.toLowerCase();
  return haystack.includes('force') || haystack.includes('rebase');
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   repoPath: string,
 *   lookbackHours?: number,
 *   expectedAuthors: string[],
 * }} input
 * @returns {Promise<{
 *   ok: boolean,
 *   commits: Array<{
 *     hash: string, author: string, timestamp: string,
 *     subject: string, refs: string,
 *     suspicious: boolean, reason?: string
 *   }>,
 *   forcePushDetected: boolean,
 *   unknownBranches: string[],
 *   severity: 'clean' | 'low' | 'medium' | 'high',
 *   checked_at: string,
 * }>}
 */
async function handler(input) {
  const checked_at = new Date().toISOString();

  if (!sshBackend.isConnected()) {
    throw new Error('SSH not connected — cannot run git audit');
  }

  const { appliance }    = getConfig();
  const toolCfg          = appliance.tools?.git_audit ?? {};
  const lookbackHours    = input.lookbackHours    ?? toolCfg.lookback_hours    ?? DEFAULT_LOOKBACK_HOURS;
  const expectedAuthors  = input.expectedAuthors  ?? toolCfg.expected_authors  ?? [];
  const repoPath         = input.repoPath;

  // Validate repoPath is an absolute path to prevent shell injection through
  // unexpected characters.  We only allow paths starting with '/' followed by
  // printable non-shell-special characters.
  if (!/^\/[^\x00-\x1f;|&`$(){}[\]<>\\*?!~#]+$/.test(repoPath)) {
    throw new Error(`git_audit: invalid repoPath "${repoPath}"`);
  }

  // ── 1. Fetch git log over SSH ─────────────────────────────────────────────
  //
  // --pretty=format produces one line per commit without the trailing newline
  // that --format adds.  Fields: hash | authorEmail | isoDate | subject | decorations
  // We use double-quotes in the shell to avoid word-splitting on the path.
  const cmd = `git -C "${repoPath}" log --since="${lookbackHours} hours ago" ` +
              `--pretty=format:"%H|%ae|%ai|%s|%D" --all 2>/dev/null || true`;

  log.info(`git_audit: fetching log from ${repoPath} (last ${lookbackHours}h)`);

  const result = await sshBackend.exec(cmd);

  if (!result.stdout || result.stdout.trim() === '') {
    log.info('git_audit: no commits in lookback window');
    return {
      ok:                 true,
      commits:            [],
      forcePushDetected:  false,
      unknownBranches:    [],
      severity:           'clean',
      checked_at,
    };
  }

  // ── 2. Parse log lines ────────────────────────────────────────────────────
  const lines   = result.stdout.split('\n').filter((l) => l.trim());
  const commits = [];

  for (const line of lines) {
    const parsed = parseLogLine(line);
    if (!parsed) {
      log.warn(`git_audit: unparseable log line: ${line.slice(0, 80)}`);
      continue;
    }
    commits.push(parsed);
  }

  log.info(`git_audit: parsed ${commits.length} commit(s)`);

  // ── 3. Analyse commits ────────────────────────────────────────────────────
  const authorSet         = new Set(expectedAuthors.map((a) => a.toLowerCase().trim()));
  let   forcePushDetected = false;
  const unknownBranchSet  = new Set();

  const annotated = commits.map((c) => {
    const reasons = [];

    // Unknown author
    if (!authorSet.has(c.author.toLowerCase())) {
      reasons.push(`unauthorized author: ${c.author}`);
    }

    // Suspicious subject
    if (isSuspiciousSubject(c.subject)) {
      reasons.push(`suspicious subject keyword detected`);
    }

    // Force-push heuristic
    if (looksLikeForcePush(c.subject, c.refs)) {
      const branches = extractBranches(c.refs);
      const onProtected = branches.some(
        (b) => PROTECTED_BRANCHES.some((p) => b === p || b.endsWith(`/${p}`))
      );
      if (onProtected) {
        forcePushDetected = true;
        reasons.push(`possible force-push on protected branch`);
      }
    }

    // Unknown branches
    const branches = extractBranches(c.refs);
    for (const b of branches) {
      // A branch is "unknown" if it is not a well-known remote-tracking or local
      // variant of an expected branch.  For simplicity we flag branches that
      // contain unusual characters or don't start with origin/ and aren't main/master/HEAD.
      const local = b.replace(/^origin\//, '');
      if (
        local !== 'HEAD' &&
        !['main', 'master', 'develop', 'dev'].includes(local) &&
        !/^(feature|fix|hotfix|release|chore|refactor)\//.test(local)
      ) {
        unknownBranchSet.add(b);
        reasons.push(`unknown branch ref: ${b}`);
      }
    }

    const suspicious = reasons.length > 0;
    return suspicious
      ? { ...c, suspicious, reason: reasons.join('; ') }
      : { ...c, suspicious };
  });

  // ── 4. Compute aggregate severity ─────────────────────────────────────────
  const unknownBranches = [...unknownBranchSet];

  let severity = 'clean';

  const hasHighSeverity = annotated.some(
    (c) =>
      c.suspicious &&
      (c.reason?.includes('force-push') || c.reason?.includes('suspicious subject'))
  );
  const hasMediumSeverity = annotated.some(
    (c) =>
      c.suspicious &&
      (c.reason?.includes('unauthorized author') || c.reason?.includes('unknown branch'))
  );

  if (hasHighSeverity || forcePushDetected) {
    severity = 'high';
  } else if (hasMediumSeverity || unknownBranches.length > 0) {
    severity = 'medium';
  }

  const ok = severity === 'clean';

  log.info(
    `git_audit: severity=${severity} commits=${commits.length} ` +
    `forcePush=${forcePushDetected} unknownBranches=${unknownBranches.length}`
  );

  return {
    ok,
    commits:           annotated,
    forcePushDetected,
    unknownBranches,
    severity,
    checked_at,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
