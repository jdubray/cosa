'use strict';

/**
 * Unit tests for src/tools/git-audit.js
 *
 * Acceptance Criteria covered:
 *   AC1 — accepts repoPath, lookbackHours (default 8), expectedAuthors from config
 *   AC2 — executes git log --since over SSH with hash|author|ts|subject|refs format
 *   AC3 — returns commits array with suspicious flag and reason for anomalous commits
 *   AC4 — returns forcePushDetected boolean and unknownBranches array
 *   AC5 — severity is 'clean' when all commits from expected authors, no force push
 *   AC6 — commit from unexpected author returns severity 'medium'
 *   AC7 — force push on main returns severity 'high'
 *   AC8 — risk level is 'read'
 */

// ---------------------------------------------------------------------------
// Mocks — hoisted before any require()
// ---------------------------------------------------------------------------

const mockIsConnected = jest.fn();
const mockExec        = jest.fn();
const mockGetConfig   = jest.fn();

jest.mock('../../src/ssh-backend', () => ({
  isConnected: (...a) => mockIsConnected(...a),
  exec:        (...a) => mockExec(...a),
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

const { handler, riskLevel, name } = require('../../src/tools/git-audit');

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const REPO_PATH      = '/home/weather';
const KNOWN_AUTHOR   = 'dev@example.com';
const UNKNOWN_AUTHOR = 'hacker@evil.com';
const TIMESTAMP      = '2026-03-29 10:00:00 +0000';

const BASE_CONFIG = {
  appliance: {
    tools: {
      git_audit: {
        repo_path:        REPO_PATH,
        expected_authors: [KNOWN_AUTHOR],
        lookback_hours:   8,
      },
    },
  },
};

/** Base input passed to every handler() call unless overridden. */
const BASE_INPUT = {
  repoPath:        REPO_PATH,
  expectedAuthors: [KNOWN_AUTHOR],
};

/**
 * Build a pipe-delimited git log line in the format produced by
 * `--pretty=format:"%H|%ae|%ai|%s|%D"`.
 */
function commitLine(hash, author, ts, subject, refs = '') {
  return `${hash}|${author}|${ts}|${subject}|${refs}`;
}

/** Wrap stdout in a resolved exec result. */
function ok(stdout) {
  return Promise.resolve({ stdout, exitCode: 0 });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockIsConnected.mockReturnValue(true);
  mockExec.mockReset();                                          // clear call history
  mockExec.mockResolvedValue({ stdout: '', exitCode: 0 });
  mockGetConfig.mockReturnValue(BASE_CONFIG);
});

// ---------------------------------------------------------------------------
// AC8 — Module metadata
// ---------------------------------------------------------------------------

describe('AC8 — module metadata', () => {
  it('exports name = "git_audit"', () => {
    expect(name).toBe('git_audit');
  });

  it('exports riskLevel = "read"', () => {
    expect(riskLevel).toBe('read');
  });
});

// ---------------------------------------------------------------------------
// AC1 — Input handling and defaults
// ---------------------------------------------------------------------------

describe('AC1 — input handling and defaults', () => {
  it('uses lookbackHours=8 when not provided in input', async () => {
    await handler(BASE_INPUT);
    const cmd = mockExec.mock.calls[0][0];
    expect(cmd).toContain('8 hours ago');
  });

  it('uses lookbackHours from input when provided', async () => {
    await handler({ ...BASE_INPUT, lookbackHours: 24 });
    const cmd = mockExec.mock.calls[0][0];
    expect(cmd).toContain('24 hours ago');
  });

  it('uses lookback_hours from appliance config when not in input', async () => {
    mockGetConfig.mockReturnValue({
      appliance: {
        tools: {
          git_audit: { lookback_hours: 48, expected_authors: [KNOWN_AUTHOR] },
        },
      },
    });
    await handler(BASE_INPUT);
    const cmd = mockExec.mock.calls[0][0];
    expect(cmd).toContain('48 hours ago');
  });

  it('uses repo_path from appliance config when input.repoPath is omitted', async () => {
    // Regression: cron called handler({}) and the tool used to read only
    // input.repoPath, throwing `invalid repoPath "undefined"` every 8h.
    await handler({});
    expect(mockExec.mock.calls[0][0]).toContain(`git -C "${REPO_PATH}"`);
  });

  it('throws "invalid repoPath" when neither input nor config provides repo_path', async () => {
    mockGetConfig.mockReturnValue({
      appliance: { tools: { git_audit: { expected_authors: [KNOWN_AUTHOR] } } },
    });
    await expect(handler({})).rejects.toThrow('invalid repoPath');
  });

  it('uses expectedAuthors from input over config', async () => {
    const altAuthor = 'other@example.com';
    mockExec.mockResolvedValue({
      stdout: commitLine('abc', altAuthor, TIMESTAMP, 'fix: something', ''),
      exitCode: 0,
    });
    const result = await handler({ ...BASE_INPUT, expectedAuthors: [altAuthor] });
    expect(result.commits[0].suspicious).toBe(false);
  });

  it('throws when SSH is not connected', async () => {
    mockIsConnected.mockReturnValue(false);
    await expect(handler(BASE_INPUT)).rejects.toThrow('SSH not connected');
  });

  it('throws on a repoPath containing shell-special characters', async () => {
    await expect(
      handler({ ...BASE_INPUT, repoPath: '/home/weather; rm -rf /' })
    ).rejects.toThrow('invalid repoPath');
  });

  it('throws on a relative repoPath', async () => {
    await expect(
      handler({ ...BASE_INPUT, repoPath: 'relative/path' })
    ).rejects.toThrow('invalid repoPath');
  });
});

// ---------------------------------------------------------------------------
// AC2 — SSH command structure
// ---------------------------------------------------------------------------

describe('AC2 — SSH command structure', () => {
  it('includes the repoPath in the git -C flag', async () => {
    await handler(BASE_INPUT);
    expect(mockExec.mock.calls[0][0]).toContain(`git -C "${REPO_PATH}"`);
  });

  it('includes --since with the lookback window', async () => {
    await handler(BASE_INPUT);
    expect(mockExec.mock.calls[0][0]).toMatch(/--since="\d+ hours ago"/);
  });

  it('uses the five-field pretty format: %H|%ae|%ai|%s|%D', async () => {
    await handler(BASE_INPUT);
    expect(mockExec.mock.calls[0][0]).toContain('%H|%ae|%ai|%s|%D');
  });

  it('passes --all to cover all branches', async () => {
    await handler(BASE_INPUT);
    expect(mockExec.mock.calls[0][0]).toContain('--all');
  });
});

// ---------------------------------------------------------------------------
// AC3 — Commits array: suspicious flag and reasons
// ---------------------------------------------------------------------------

describe('AC3 — commit annotations', () => {
  it('clean commit has suspicious=false and no reason field', async () => {
    mockExec.mockResolvedValue({
      stdout: commitLine('abc123', KNOWN_AUTHOR, TIMESTAMP, 'fix: correct calculation', 'HEAD -> main'),
      exitCode: 0,
    });
    const result = await handler(BASE_INPUT);
    expect(result.commits).toHaveLength(1);
    expect(result.commits[0].suspicious).toBe(false);
    expect(result.commits[0].reason).toBeUndefined();
  });

  it('commit from unexpected author has suspicious=true and reason mentioning the author', async () => {
    mockExec.mockResolvedValue({
      stdout: commitLine('abc123', UNKNOWN_AUTHOR, TIMESTAMP, 'add: new feature', ''),
      exitCode: 0,
    });
    const result = await handler(BASE_INPUT);
    expect(result.commits[0].suspicious).toBe(true);
    expect(result.commits[0].reason).toMatch(/unauthorized author/i);
    expect(result.commits[0].reason).toContain(UNKNOWN_AUTHOR);
  });

  it('commit with "eval" in subject has suspicious=true', async () => {
    mockExec.mockResolvedValue({
      stdout: commitLine('abc123', KNOWN_AUTHOR, TIMESTAMP, 'debug: added eval for testing', ''),
      exitCode: 0,
    });
    const result = await handler(BASE_INPUT);
    expect(result.commits[0].suspicious).toBe(true);
    expect(result.commits[0].reason).toMatch(/suspicious subject/i);
  });

  it('commit with "exec" in subject has suspicious=true', async () => {
    mockExec.mockResolvedValue({
      stdout: commitLine('abc123', KNOWN_AUTHOR, TIMESTAMP, 'chore: use exec for subprocess', ''),
      exitCode: 0,
    });
    const result = await handler(BASE_INPUT);
    expect(result.commits[0].suspicious).toBe(true);
  });

  it('commit with "base64" in subject has suspicious=true', async () => {
    mockExec.mockResolvedValue({
      stdout: commitLine('abc123', KNOWN_AUTHOR, TIMESTAMP, 'feat: encode data with base64', ''),
      exitCode: 0,
    });
    const result = await handler(BASE_INPUT);
    expect(result.commits[0].suspicious).toBe(true);
  });

  it('author comparison is case-insensitive', async () => {
    mockExec.mockResolvedValue({
      stdout: commitLine('abc123', 'Dev@Example.Com', TIMESTAMP, 'fix: normalise', 'origin/main'),
      exitCode: 0,
    });
    const result = await handler({ ...BASE_INPUT, expectedAuthors: ['dev@example.com'] });
    expect(result.commits[0].suspicious).toBe(false);
  });

  it('each commit row includes hash, author, timestamp, subject, refs', async () => {
    mockExec.mockResolvedValue({
      stdout: commitLine('deadbeef', KNOWN_AUTHOR, TIMESTAMP, 'feat: add thing', 'HEAD -> main'),
      exitCode: 0,
    });
    const result = await handler(BASE_INPUT);
    const c = result.commits[0];
    expect(c.hash).toBe('deadbeef');
    expect(c.author).toBe(KNOWN_AUTHOR);
    expect(c.timestamp).toBe(TIMESTAMP);
    expect(c.subject).toBe('feat: add thing');
    expect(c.refs).toBeDefined();
  });

  it('subject containing pipes is parsed correctly (last field is refs)', async () => {
    // Subject: "fix: pipe | separator | case"  refs: "origin/main"
    const rawLine = `abc123|${KNOWN_AUTHOR}|${TIMESTAMP}|fix: pipe | separator | case|origin/main`;
    mockExec.mockResolvedValue({ stdout: rawLine, exitCode: 0 });
    const result = await handler(BASE_INPUT);
    expect(result.commits[0].subject).toBe('fix: pipe | separator | case');
    expect(result.commits[0].refs).toBe('origin/main');
  });

  it('multiple commits are all annotated', async () => {
    const lines = [
      commitLine('aaa', KNOWN_AUTHOR,   TIMESTAMP, 'fix: one',   'origin/main'),
      commitLine('bbb', UNKNOWN_AUTHOR, TIMESTAMP, 'feat: two',  ''),
      commitLine('ccc', KNOWN_AUTHOR,   TIMESTAMP, 'docs: three',''),
    ].join('\n');
    mockExec.mockResolvedValue({ stdout: lines, exitCode: 0 });
    const result = await handler(BASE_INPUT);
    expect(result.commits).toHaveLength(3);
    expect(result.commits[0].suspicious).toBe(false);
    expect(result.commits[1].suspicious).toBe(true);
    expect(result.commits[2].suspicious).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC4 — forcePushDetected and unknownBranches
// ---------------------------------------------------------------------------

describe('AC4 — forcePushDetected and unknownBranches', () => {
  it('result always contains forcePushDetected boolean', async () => {
    const result = await handler(BASE_INPUT);
    expect(typeof result.forcePushDetected).toBe('boolean');
  });

  it('result always contains unknownBranches array', async () => {
    const result = await handler(BASE_INPUT);
    expect(Array.isArray(result.unknownBranches)).toBe(true);
  });

  it('forcePushDetected is false when no force-push signal in commit', async () => {
    mockExec.mockResolvedValue({
      stdout: commitLine('abc', KNOWN_AUTHOR, TIMESTAMP, 'fix: normal commit', 'HEAD -> main'),
      exitCode: 0,
    });
    const result = await handler(BASE_INPUT);
    expect(result.forcePushDetected).toBe(false);
  });

  it('forcePushDetected is true when "force" appears in subject on main', async () => {
    mockExec.mockResolvedValue({
      stdout: commitLine('abc', KNOWN_AUTHOR, TIMESTAMP, 'force push update', 'HEAD -> main, origin/main'),
      exitCode: 0,
    });
    const result = await handler(BASE_INPUT);
    expect(result.forcePushDetected).toBe(true);
  });

  it('forcePushDetected is false when "force" appears on a non-protected branch', async () => {
    mockExec.mockResolvedValue({
      stdout: commitLine('abc', KNOWN_AUTHOR, TIMESTAMP, 'force push staging', 'HEAD -> feature/foo'),
      exitCode: 0,
    });
    const result = await handler(BASE_INPUT);
    expect(result.forcePushDetected).toBe(false);
  });

  it('unknownBranches includes unusual branch names', async () => {
    mockExec.mockResolvedValue({
      stdout: commitLine('abc', KNOWN_AUTHOR, TIMESTAMP, 'test: commit', 'HEAD -> exfil-branch'),
      exitCode: 0,
    });
    const result = await handler(BASE_INPUT);
    expect(result.unknownBranches.length).toBeGreaterThan(0);
  });

  it('unknownBranches is empty for standard branch names (main, feature/, fix/)', async () => {
    const lines = [
      commitLine('aaa', KNOWN_AUTHOR, TIMESTAMP, 'feat: one',  'HEAD -> main, origin/main'),
      commitLine('bbb', KNOWN_AUTHOR, TIMESTAMP, 'feat: two',  'HEAD -> feature/my-branch'),
      commitLine('ccc', KNOWN_AUTHOR, TIMESTAMP, 'fix: three', 'HEAD -> fix/bug-123'),
    ].join('\n');
    mockExec.mockResolvedValue({ stdout: lines, exitCode: 0 });
    const result = await handler(BASE_INPUT);
    expect(result.unknownBranches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC5 — 'clean' severity
// ---------------------------------------------------------------------------

describe('AC5 — clean severity', () => {
  it('returns severity=clean and ok=true when log is empty', async () => {
    mockExec.mockResolvedValue({ stdout: '', exitCode: 0 });
    const result = await handler(BASE_INPUT);
    expect(result.severity).toBe('clean');
    expect(result.ok).toBe(true);
  });

  it('returns severity=clean when all commits are from expected authors', async () => {
    const lines = [
      commitLine('aaa', KNOWN_AUTHOR, TIMESTAMP, 'fix: one',   'HEAD -> main, origin/main'),
      commitLine('bbb', KNOWN_AUTHOR, TIMESTAMP, 'fix: two',   'origin/main'),
    ].join('\n');
    mockExec.mockResolvedValue({ stdout: lines, exitCode: 0 });
    const result = await handler(BASE_INPUT);
    expect(result.severity).toBe('clean');
    expect(result.ok).toBe(true);
  });

  it('returns severity=clean with multiple expected authors all present', async () => {
    const authorB = 'ci-bot@example.com';
    const lines = [
      commitLine('aaa', KNOWN_AUTHOR, TIMESTAMP, 'fix: human',  ''),
      commitLine('bbb', authorB,      TIMESTAMP, 'ci: deploy',  ''),
    ].join('\n');
    mockExec.mockResolvedValue({ stdout: lines, exitCode: 0 });
    const result = await handler({ ...BASE_INPUT, expectedAuthors: [KNOWN_AUTHOR, authorB] });
    expect(result.severity).toBe('clean');
  });

  it('empty log returns forcePushDetected=false and unknownBranches=[]', async () => {
    const result = await handler(BASE_INPUT);
    expect(result.forcePushDetected).toBe(false);
    expect(result.unknownBranches).toHaveLength(0);
    expect(result.commits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC6 — 'medium' severity for unauthorized author
// ---------------------------------------------------------------------------

describe('AC6 — medium severity for unauthorized author', () => {
  it('returns severity=medium when one commit is from an unexpected author', async () => {
    mockExec.mockResolvedValue({
      stdout: commitLine('abc', UNKNOWN_AUTHOR, TIMESTAMP, 'feat: add backdoor', ''),
      exitCode: 0,
    });
    const result = await handler(BASE_INPUT);
    expect(result.severity).toBe('medium');
    expect(result.ok).toBe(false);
  });

  it('returns severity=medium when one of many commits has an unknown author', async () => {
    const lines = [
      commitLine('aaa', KNOWN_AUTHOR,   TIMESTAMP, 'fix: legitimate', 'origin/main'),
      commitLine('bbb', UNKNOWN_AUTHOR, TIMESTAMP, 'add: injected',   ''),
      commitLine('ccc', KNOWN_AUTHOR,   TIMESTAMP, 'chore: cleanup',  ''),
    ].join('\n');
    mockExec.mockResolvedValue({ stdout: lines, exitCode: 0 });
    const result = await handler(BASE_INPUT);
    expect(result.severity).toBe('medium');
  });

  it('the unexpected-author commit is flagged with reason containing the email', async () => {
    mockExec.mockResolvedValue({
      stdout: commitLine('abc', UNKNOWN_AUTHOR, TIMESTAMP, 'test: something', ''),
      exitCode: 0,
    });
    const result = await handler(BASE_INPUT);
    const flagged = result.commits.find((c) => c.suspicious);
    expect(flagged.reason).toContain(UNKNOWN_AUTHOR);
  });

  it('unknown-branch commit also produces medium severity', async () => {
    mockExec.mockResolvedValue({
      stdout: commitLine('abc', KNOWN_AUTHOR, TIMESTAMP, 'wip: experiment', 'HEAD -> exfil-branch'),
      exitCode: 0,
    });
    const result = await handler(BASE_INPUT);
    expect(result.severity).toBe('medium');
  });
});

// ---------------------------------------------------------------------------
// AC7 — 'high' severity for force push on main
// ---------------------------------------------------------------------------

describe('AC7 — high severity for force push on protected branch', () => {
  it('returns severity=high when force push detected on main', async () => {
    mockExec.mockResolvedValue({
      stdout: commitLine('abc', KNOWN_AUTHOR, TIMESTAMP, 'force push deployment', 'HEAD -> main, origin/main'),
      exitCode: 0,
    });
    const result = await handler(BASE_INPUT);
    expect(result.severity).toBe('high');
    expect(result.forcePushDetected).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('returns severity=high when force push detected on master', async () => {
    mockExec.mockResolvedValue({
      stdout: commitLine('abc', KNOWN_AUTHOR, TIMESTAMP, 'force push rollback', 'HEAD -> master, origin/master'),
      exitCode: 0,
    });
    const result = await handler(BASE_INPUT);
    expect(result.severity).toBe('high');
    expect(result.forcePushDetected).toBe(true);
  });

  it('returns severity=high when "rebase" detected on main', async () => {
    mockExec.mockResolvedValue({
      stdout: commitLine('abc', KNOWN_AUTHOR, TIMESTAMP, 'rebase history cleanup', 'HEAD -> main'),
      exitCode: 0,
    });
    const result = await handler(BASE_INPUT);
    expect(result.severity).toBe('high');
  });

  it('high severity overrides medium (force push + unknown author together)', async () => {
    mockExec.mockResolvedValue({
      stdout: commitLine('abc', UNKNOWN_AUTHOR, TIMESTAMP, 'force push deployment', 'HEAD -> main'),
      exitCode: 0,
    });
    const result = await handler(BASE_INPUT);
    expect(result.severity).toBe('high');
  });

  it('suspicious subject keyword (eval) also produces high severity', async () => {
    mockExec.mockResolvedValue({
      stdout: commitLine('abc', KNOWN_AUTHOR, TIMESTAMP, 'debug: eval hook injected', ''),
      exitCode: 0,
    });
    const result = await handler(BASE_INPUT);
    expect(result.severity).toBe('high');
  });

  it('force push on non-protected branch does NOT produce high severity', async () => {
    mockExec.mockResolvedValue({
      stdout: commitLine('abc', KNOWN_AUTHOR, TIMESTAMP, 'force push develop', 'HEAD -> develop'),
      exitCode: 0,
    });
    const result = await handler(BASE_INPUT);
    // develop is not main/master — severity should be clean (known author, known branch)
    expect(result.severity).toBe('clean');
    expect(result.forcePushDetected).toBe(false);
  });
});
