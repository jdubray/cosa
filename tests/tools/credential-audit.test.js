'use strict';

/**
 * Unit tests for src/tools/credential-audit.js
 *
 * Acceptance Criteria covered:
 *   AC1 — scans .ts/.js/.json/.env/.yaml/.yml files via git grep over SSH
 *   AC2 — detects Clover live key pattern (sk_live_)
 *   AC3 — detects AWS access key pattern (AKIA...)
 *   AC4 — detects base64-encoded secrets and password= patterns
 *   AC5 — checks .gitignore covers .env and secrets directories
 *   AC6 — findings include file, line, pattern, severity, redacted snippet
 *   AC7 — returns gitignoreCoverage object
 *   AC8 — risk level is 'read'
 */

// ---------------------------------------------------------------------------
// Mocks — hoisted before any require()
// ---------------------------------------------------------------------------

const mockIsConnected        = jest.fn();
const mockExec               = jest.fn();
const mockGetConfig          = jest.fn();
const mockIsSuppressionActive = jest.fn();

jest.mock('../../src/ssh-backend', () => ({
  isConnected: (...a) => mockIsConnected(...a),
  exec:        (...a) => mockExec(...a),
}));

jest.mock('../../config/cosa.config', () => ({
  getConfig: (...a) => mockGetConfig(...a),
}));

jest.mock('../../src/session-store', () => ({
  isSuppressionActive: (...a) => mockIsSuppressionActive(...a),
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

const { handler, riskLevel, name } = require('../../src/tools/credential-audit');

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const BASE_CONFIG = {
  appliance: {
    tools: {
      credential_audit: { repo_path: '/home/weather' },
    },
  },
};

/** git grep exit 1 = no matches (not an error). */
const NO_MATCH = { stdout: '', stderr: '', exitCode: 1 };
/** .gitignore fetch — good coverage. */
const GITIGNORE_FULL = {
  stdout: '.env\nsecrets/\nnode_modules/\n',
  stderr: '',
  exitCode: 0,
};
/** .gitignore fetch — missing both entries. */
const GITIGNORE_EMPTY = { stdout: '', stderr: '', exitCode: 0 };

/**
 * Build a git grep result line.
 * Format: <file>:<linenum>:<content>
 */
function grepLine(file, lineNum, content) {
  return `${file}:${lineNum}:${content}`;
}

/**
 * Return a mockExec implementation that:
 *   - Returns the given match result for the first git grep call that
 *     matches the supplied patternSubstring.
 *   - Returns NO_MATCH for all other git grep calls.
 *   - Returns gitignoreResult for the .gitignore fetch call.
 */
function makeExecForPattern(patternSubstring, matchStdout, gitignoreResult = GITIGNORE_FULL) {
  return jest.fn().mockImplementation((cmd) => {
    if (cmd.includes('.gitignore') || cmd.includes('cat ')) {
      return Promise.resolve(gitignoreResult);
    }
    if (cmd.includes(patternSubstring)) {
      return Promise.resolve({ stdout: matchStdout, stderr: '', exitCode: 0 });
    }
    return Promise.resolve(NO_MATCH);
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockGetConfig.mockReturnValue(BASE_CONFIG);
  mockIsConnected.mockReturnValue(true);
  mockIsSuppressionActive.mockReturnValue(false);
  // Default: no matches for any pattern; full gitignore coverage.
  mockExec.mockImplementation((cmd) => {
    if (cmd.includes('.gitignore') || cmd.includes('cat ')) {
      return Promise.resolve(GITIGNORE_FULL);
    }
    return Promise.resolve(NO_MATCH);
  });
});

// ---------------------------------------------------------------------------
// AC8 — module metadata
// ---------------------------------------------------------------------------

describe('AC8 — module metadata', () => {
  it('exports name = credential_audit', () => {
    expect(name).toBe('credential_audit');
  });

  it('exports riskLevel = read', () => {
    expect(riskLevel).toBe('read');
  });
});

// ---------------------------------------------------------------------------
// AC1 — git grep over SSH on tracked file types
// ---------------------------------------------------------------------------

describe('AC1 — git grep via SSH on tracked file types', () => {
  it('calls sshBackend.exec with git grep commands', async () => {
    await handler();
    const cmds = mockExec.mock.calls.map((c) => c[0]);
    expect(cmds.some((c) => c.includes('git') && c.includes('grep'))).toBe(true);
  });

  it('throws when SSH is not connected', async () => {
    mockIsConnected.mockReturnValue(false);
    await expect(handler()).rejects.toThrow(/SSH not connected/i);
  });

  it('grep command includes *.ts pathspec', async () => {
    await handler();
    const cmds = mockExec.mock.calls.map((c) => c[0]);
    const grepCmds = cmds.filter((c) => c.includes('git') && c.includes('grep'));
    expect(grepCmds.some((c) => c.includes('*.ts'))).toBe(true);
  });

  it('grep command includes *.json pathspec', async () => {
    await handler();
    const cmds = mockExec.mock.calls.map((c) => c[0]);
    const grepCmds = cmds.filter((c) => c.includes('git') && c.includes('grep'));
    expect(grepCmds.some((c) => c.includes('*.json'))).toBe(true);
  });

  it('grep command includes *.yaml and *.yml pathspecs', async () => {
    await handler();
    const cmds = mockExec.mock.calls.map((c) => c[0]);
    const grepCmds = cmds.filter((c) => c.includes('git') && c.includes('grep'));
    expect(grepCmds.some((c) => c.includes('*.yaml') && c.includes('*.yml'))).toBe(true);
  });

  it('uses the configured repo_path in git grep commands', async () => {
    await handler();
    const cmds = mockExec.mock.calls.map((c) => c[0]);
    expect(cmds.some((c) => c.includes('/home/weather'))).toBe(true);
  });

  it('tolerates git grep exit code 1 (no matches) without error', async () => {
    mockExec.mockResolvedValue(NO_MATCH); // all calls return no-match
    await expect(handler()).resolves.toBeDefined();
  });

  it('skips a pattern when git grep exits > 1 (error) but continues with others', async () => {
    let callCount = 0;
    mockExec.mockImplementation((cmd) => {
      if (cmd.includes('.gitignore') || cmd.includes('cat ')) {
        return Promise.resolve(GITIGNORE_FULL);
      }
      callCount++;
      if (callCount === 1) {
        // First git grep call returns an error exit code.
        return Promise.resolve({ stdout: '', stderr: 'fatal: not a git repo', exitCode: 128 });
      }
      return Promise.resolve(NO_MATCH);
    });

    const result = await handler();
    // Must complete despite the error — other patterns still run.
    expect(result).toHaveProperty('findings');
  });
});

// ---------------------------------------------------------------------------
// AC2 — Clover live key detection (sk_live_)
// ---------------------------------------------------------------------------

describe('AC2 — Clover live key (sk_live_) detection', () => {
  it('detects sk_live_ pattern and adds a critical finding', async () => {
    mockExec.mockImplementation((cmd) => {
      if (cmd.includes('.gitignore') || cmd.includes('cat ')) return Promise.resolve(GITIGNORE_FULL);
      if (cmd.includes('sk_live_')) {
        return Promise.resolve({
          stdout: grepLine('src/config.js', 12, "const API_KEY = 'sk_live_abc123xyz';"),
          stderr: '',
          exitCode: 0,
        });
      }
      return Promise.resolve(NO_MATCH);
    });

    const result = await handler();
    const finding = result.findings.find((f) => f.pattern === 'clover_live_key');
    expect(finding).toBeDefined();
    expect(finding.severity).toBe('critical');
  });

  it('clover_live_key finding has correct file and line', async () => {
    mockExec.mockImplementation((cmd) => {
      if (cmd.includes('.gitignore') || cmd.includes('cat ')) return Promise.resolve(GITIGNORE_FULL);
      if (cmd.includes('sk_live_')) {
        return Promise.resolve({
          stdout: grepLine('src/config.js', 42, "KEY='sk_live_abcdef123456'"),
          stderr: '',
          exitCode: 0,
        });
      }
      return Promise.resolve(NO_MATCH);
    });

    const result = await handler();
    const finding = result.findings.find((f) => f.pattern === 'clover_live_key');
    expect(finding).toBeDefined();
    expect(finding.file).toBe('src/config.js');
    expect(finding.line).toBe(42);
    expect(finding.severity).toBe('critical');
  });
});

// ---------------------------------------------------------------------------
// AC3 — AWS access key detection (AKIA...)
// ---------------------------------------------------------------------------

describe('AC3 — AWS access key (AKIA...) detection', () => {
  it('detects AKIA pattern and adds a critical finding', async () => {
    mockExec.mockImplementation((cmd) => {
      if (cmd.includes('.gitignore') || cmd.includes('cat ')) return Promise.resolve(GITIGNORE_FULL);
      if (cmd.includes('AKIA')) {
        return Promise.resolve({
          stdout: grepLine('.env', 3, 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE'),
          stderr: '',
          exitCode: 0,
        });
      }
      return Promise.resolve(NO_MATCH);
    });

    const result = await handler();
    const finding = result.findings.find((f) => f.pattern === 'aws_access_key');
    expect(finding).toBeDefined();
    expect(finding.severity).toBe('critical');
    expect(finding.file).toBe('.env');
    expect(finding.line).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// AC4 — base64 secret and password= detection
// ---------------------------------------------------------------------------

describe('AC4 — base64-encoded secrets and password= patterns', () => {
  it('detects base64_secret pattern with high severity', async () => {
    mockExec.mockImplementation((cmd) => {
      if (cmd.includes('.gitignore') || cmd.includes('cat ')) return Promise.resolve(GITIGNORE_FULL);
      if (cmd.includes('secret') && cmd.includes('=')) {
        return Promise.resolve({
          stdout: grepLine('config.yaml', 7, 'secret=dGhpcyBpcyBhIHZlcnkgbG9uZyBiYXNlNjQgc2VjcmV0'),
          stderr: '',
          exitCode: 0,
        });
      }
      return Promise.resolve(NO_MATCH);
    });

    const result = await handler();
    const finding = result.findings.find((f) => f.pattern === 'base64_secret');
    expect(finding).toBeDefined();
    expect(finding.severity).toBe('high');
  });

  it('detects password_assignment pattern with high severity', async () => {
    mockExec.mockImplementation((cmd) => {
      if (cmd.includes('.gitignore') || cmd.includes('cat ')) return Promise.resolve(GITIGNORE_FULL);
      if (cmd.includes('[=:]')) {
        return Promise.resolve({
          stdout: grepLine('src/db.js', 15, "password = 'myS3cretPass'"),
          stderr: '',
          exitCode: 0,
        });
      }
      return Promise.resolve(NO_MATCH);
    });

    const result = await handler();
    const finding = result.findings.find((f) => f.pattern === 'password_assignment');
    expect(finding).toBeDefined();
    expect(finding.severity).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// AC5 — .gitignore coverage checks
// ---------------------------------------------------------------------------

describe('AC5 — .gitignore coverage', () => {
  it('coversEnv is true when .env is in .gitignore', async () => {
    mockExec.mockImplementation((cmd) => {
      if (cmd.includes('.gitignore') || cmd.includes('cat ')) {
        return Promise.resolve({ stdout: '.env\nnode_modules/', stderr: '', exitCode: 0 });
      }
      return Promise.resolve(NO_MATCH);
    });
    const result = await handler();
    expect(result.gitignoreCoverage.coversEnv).toBe(true);
  });

  it('coversEnv is false when .env is NOT in .gitignore', async () => {
    mockExec.mockImplementation((cmd) => {
      if (cmd.includes('.gitignore') || cmd.includes('cat ')) {
        return Promise.resolve({ stdout: 'node_modules/', stderr: '', exitCode: 0 });
      }
      return Promise.resolve(NO_MATCH);
    });
    const result = await handler();
    expect(result.gitignoreCoverage.coversEnv).toBe(false);
  });

  it('coversSecrets is true when secrets/ is in .gitignore', async () => {
    mockExec.mockImplementation((cmd) => {
      if (cmd.includes('.gitignore') || cmd.includes('cat ')) {
        return Promise.resolve({ stdout: '.env\nsecrets/\n', stderr: '', exitCode: 0 });
      }
      return Promise.resolve(NO_MATCH);
    });
    const result = await handler();
    expect(result.gitignoreCoverage.coversSecrets).toBe(true);
  });

  it('coversSecrets is false when secrets/ is NOT in .gitignore', async () => {
    mockExec.mockImplementation((cmd) => {
      if (cmd.includes('.gitignore') || cmd.includes('cat ')) {
        return Promise.resolve({ stdout: '.env\n', stderr: '', exitCode: 0 });
      }
      return Promise.resolve(NO_MATCH);
    });
    const result = await handler();
    expect(result.gitignoreCoverage.coversSecrets).toBe(false);
  });

  it('coversEnv is true for *.env wildcard pattern', async () => {
    mockExec.mockImplementation((cmd) => {
      if (cmd.includes('.gitignore') || cmd.includes('cat ')) {
        return Promise.resolve({ stdout: '*.env\n', stderr: '', exitCode: 0 });
      }
      return Promise.resolve(NO_MATCH);
    });
    const result = await handler();
    expect(result.gitignoreCoverage.coversEnv).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC6 — findings structure
// ---------------------------------------------------------------------------

describe('AC6 — findings array structure', () => {
  beforeEach(() => {
    mockExec.mockImplementation((cmd) => {
      if (cmd.includes('.gitignore') || cmd.includes('cat ')) return Promise.resolve(GITIGNORE_FULL);
      if (cmd.includes('sk_live_')) {
        return Promise.resolve({
          stdout: grepLine('src/payment.js', 7, "key = 'sk_live_abc123def456'"),
          stderr: '',
          exitCode: 0,
        });
      }
      return Promise.resolve(NO_MATCH);
    });
  });

  it('each finding has file, line, pattern, severity, description, snippet', async () => {
    const result = await handler();
    expect(result.findings.length).toBeGreaterThan(0);
    const f = result.findings[0];
    expect(f).toHaveProperty('file');
    expect(f).toHaveProperty('line');
    expect(f).toHaveProperty('pattern');
    expect(f).toHaveProperty('severity');
    expect(f).toHaveProperty('description');
    expect(f).toHaveProperty('snippet');
  });

  it('snippet is redacted — does not contain the raw secret value', async () => {
    const result = await handler();
    const f = result.findings.find((x) => x.pattern === 'clover_live_key');
    expect(f).toBeDefined();
    // The raw value after sk_live_ should not appear verbatim.
    expect(f.snippet).not.toMatch(/sk_live_abc123def456/);
    expect(f.snippet).toContain('[REDACTED]');
  });

  it('snippet preserves the sk_live_ prefix for traceability', async () => {
    const result = await handler();
    const f = result.findings.find((x) => x.pattern === 'clover_live_key');
    expect(f.snippet).toContain('sk_live_');
  });

  it('snippet is capped at 120 characters', async () => {
    const longLine = `key = 'sk_live_${'a'.repeat(200)}'`;
    mockExec.mockImplementation((cmd) => {
      if (cmd.includes('.gitignore') || cmd.includes('cat ')) return Promise.resolve(GITIGNORE_FULL);
      if (cmd.includes('sk_live_')) {
        return Promise.resolve({
          stdout: grepLine('src/payment.js', 1, longLine),
          stderr: '',
          exitCode: 0,
        });
      }
      return Promise.resolve(NO_MATCH);
    });
    const result = await handler();
    const f = result.findings.find((x) => x.pattern === 'clover_live_key');
    expect(f.snippet.length).toBeLessThanOrEqual(120);
  });

  it('AWS snippet redacts suffix but keeps AKIA prefix', async () => {
    mockExec.mockImplementation((cmd) => {
      if (cmd.includes('.gitignore') || cmd.includes('cat ')) return Promise.resolve(GITIGNORE_FULL);
      if (cmd.includes('AKIA')) {
        return Promise.resolve({
          stdout: grepLine('.env', 1, 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE'),
          stderr: '',
          exitCode: 0,
        });
      }
      return Promise.resolve(NO_MATCH);
    });
    const result = await handler();
    const f = result.findings.find((x) => x.pattern === 'aws_access_key');
    expect(f.snippet).toContain('AKIA');
    expect(f.snippet).toContain('[REDACTED]');
    expect(f.snippet).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });
});

// ---------------------------------------------------------------------------
// AC7 — gitignoreCoverage object returned
// ---------------------------------------------------------------------------

describe('AC7 — gitignoreCoverage object', () => {
  it('result includes gitignoreCoverage object', async () => {
    const result = await handler();
    expect(result).toHaveProperty('gitignoreCoverage');
    expect(typeof result.gitignoreCoverage).toBe('object');
  });

  it('gitignoreCoverage has coversEnv and coversSecrets fields', async () => {
    const result = await handler();
    expect(result.gitignoreCoverage).toHaveProperty('coversEnv');
    expect(result.gitignoreCoverage).toHaveProperty('coversSecrets');
  });

  it('result includes totalFindingCount, summary, checked_at', async () => {
    const result = await handler();
    expect(result).toHaveProperty('totalFindingCount');
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('checked_at');
    expect(typeof result.summary).toBe('string');
  });

  it('summary is clean when no findings and good gitignore coverage', async () => {
    const result = await handler();
    expect(result.summary).toMatch(/no credential exposures/i);
  });

  it('summary mentions coverage issues when .env not in gitignore', async () => {
    mockExec.mockImplementation((cmd) => {
      if (cmd.includes('.gitignore') || cmd.includes('cat ')) {
        return Promise.resolve({ stdout: 'node_modules/', stderr: '', exitCode: 0 });
      }
      return Promise.resolve(NO_MATCH);
    });
    const result = await handler();
    expect(result.summary).toMatch(/\.env not covered/i);
  });

  it('summary includes critical finding count when present', async () => {
    mockExec.mockImplementation((cmd) => {
      if (cmd.includes('.gitignore') || cmd.includes('cat ')) return Promise.resolve(GITIGNORE_FULL);
      if (cmd.includes('sk_live_')) {
        return Promise.resolve({
          stdout: grepLine('src/payment.js', 5, "key='sk_live_abc'"),
          stderr: '',
          exitCode: 0,
        });
      }
      return Promise.resolve(NO_MATCH);
    });
    const result = await handler();
    expect(result.summary).toMatch(/critical finding/i);
  });
});

// ---------------------------------------------------------------------------
// Static suppression modes (appliance.yaml tools.credential_audit.suppressed_findings)
// ---------------------------------------------------------------------------

describe('static suppression — exact tuple (pattern + file + line)', () => {
  it('suppresses a finding whose pattern, file, and line all match', async () => {
    mockGetConfig.mockReturnValue({
      appliance: {
        tools: {
          credential_audit: {
            repo_path: '/home/weather',
            suppressed_findings: [
              { pattern: 'aws_access_key', file: 'test/backup.test.ts', line: 270, reason: 'test dummy' },
            ],
          },
        },
      },
    });
    mockExec.mockImplementation((cmd) => {
      if (cmd.includes('.gitignore') || cmd.includes('cat ')) return Promise.resolve(GITIGNORE_FULL);
      if (cmd.includes('AKIA')) {
        return Promise.resolve({
          stdout: grepLine('test/backup.test.ts', 270, "const k='AKIAIOSFODNN7EXAMPLE';"),
          stderr: '',
          exitCode: 0,
        });
      }
      return Promise.resolve(NO_MATCH);
    });

    const result = await handler();
    expect(result.findings).toHaveLength(0);
    expect(result.suppressedFindings).toHaveLength(1);
    expect(result.suppressedFindings[0].file).toBe('test/backup.test.ts');
  });

  it('does NOT suppress when line differs from the tuple entry', async () => {
    mockGetConfig.mockReturnValue({
      appliance: {
        tools: {
          credential_audit: {
            repo_path: '/home/weather',
            suppressed_findings: [
              { pattern: 'aws_access_key', file: 'test/backup.test.ts', line: 270, reason: 'test dummy' },
            ],
          },
        },
      },
    });
    mockExec.mockImplementation((cmd) => {
      if (cmd.includes('.gitignore') || cmd.includes('cat ')) return Promise.resolve(GITIGNORE_FULL);
      if (cmd.includes('AKIA')) {
        return Promise.resolve({
          stdout: grepLine('test/backup.test.ts', 999, "const k='AKIAIOSFODNN7EXAMPLE';"),
          stderr: '',
          exitCode: 0,
        });
      }
      return Promise.resolve(NO_MATCH);
    });

    const result = await handler();
    expect(result.findings).toHaveLength(1);
    expect(result.suppressedFindings).toHaveLength(0);
  });
});

describe('static suppression — whole-file (line omitted)', () => {
  it('suppresses every finding of the pattern in the exact file', async () => {
    mockGetConfig.mockReturnValue({
      appliance: {
        tools: {
          credential_audit: {
            repo_path: '/home/weather',
            suppressed_findings: [
              { pattern: 'password_assignment', file: 'src/routes/merchants.ts', reason: 'SMTP config' },
            ],
          },
        },
      },
    });
    mockExec.mockImplementation((cmd) => {
      if (cmd.includes('.gitignore') || cmd.includes('cat ')) return Promise.resolve(GITIGNORE_FULL);
      if (cmd.includes('[=:]')) {
        return Promise.resolve({
          stdout: [
            grepLine('src/routes/merchants.ts', 10, "password='a1b2c3d4'"),
            grepLine('src/routes/merchants.ts', 42, "password: 'zyxwvut9'"),
          ].join('\n'),
          stderr: '',
          exitCode: 0,
        });
      }
      return Promise.resolve(NO_MATCH);
    });

    const result = await handler();
    expect(result.findings).toHaveLength(0);
    expect(result.suppressedFindings).toHaveLength(2);
  });

  it('does NOT suppress findings in other files', async () => {
    mockGetConfig.mockReturnValue({
      appliance: {
        tools: {
          credential_audit: {
            repo_path: '/home/weather',
            suppressed_findings: [
              { pattern: 'password_assignment', file: 'src/routes/merchants.ts', reason: 'SMTP config' },
            ],
          },
        },
      },
    });
    mockExec.mockImplementation((cmd) => {
      if (cmd.includes('.gitignore') || cmd.includes('cat ')) return Promise.resolve(GITIGNORE_FULL);
      if (cmd.includes('[=:]')) {
        return Promise.resolve({
          stdout: grepLine('src/routes/auth.ts', 5, "password='real-secret'"),
          stderr: '',
          exitCode: 0,
        });
      }
      return Promise.resolve(NO_MATCH);
    });

    const result = await handler();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].file).toBe('src/routes/auth.ts');
  });
});

describe('static suppression — directory prefix (file ends with /)', () => {
  it('suppresses every finding of the pattern whose path starts with the prefix', async () => {
    mockGetConfig.mockReturnValue({
      appliance: {
        tools: {
          credential_audit: {
            repo_path: '/home/weather',
            suppressed_findings: [
              { pattern: 'password_assignment', file: 'test/', reason: 'test fixtures' },
            ],
          },
        },
      },
    });
    mockExec.mockImplementation((cmd) => {
      if (cmd.includes('.gitignore') || cmd.includes('cat ')) return Promise.resolve(GITIGNORE_FULL);
      if (cmd.includes('[=:]')) {
        return Promise.resolve({
          stdout: [
            grepLine('test/auth.test.ts', 10, "password='testpw1'"),
            grepLine('test/payment.test.ts', 42, "password='testpw2'"),
            grepLine('test/nested/foo.test.ts', 7, "password='testpw3'"),
          ].join('\n'),
          stderr: '',
          exitCode: 0,
        });
      }
      return Promise.resolve(NO_MATCH);
    });

    const result = await handler();
    expect(result.findings).toHaveLength(0);
    expect(result.suppressedFindings).toHaveLength(3);
  });

  it('does NOT suppress findings outside the prefix', async () => {
    mockGetConfig.mockReturnValue({
      appliance: {
        tools: {
          credential_audit: {
            repo_path: '/home/weather',
            suppressed_findings: [
              { pattern: 'password_assignment', file: 'test/', reason: 'test fixtures' },
            ],
          },
        },
      },
    });
    mockExec.mockImplementation((cmd) => {
      if (cmd.includes('.gitignore') || cmd.includes('cat ')) return Promise.resolve(GITIGNORE_FULL);
      if (cmd.includes('[=:]')) {
        return Promise.resolve({
          stdout: [
            grepLine('test/auth.test.ts', 10, "password='testpw1'"),
            grepLine('src/routes/auth.ts', 5, "password='prodpw'"),
          ].join('\n'),
          stderr: '',
          exitCode: 0,
        });
      }
      return Promise.resolve(NO_MATCH);
    });

    const result = await handler();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].file).toBe('src/routes/auth.ts');
    expect(result.suppressedFindings).toHaveLength(1);
    expect(result.suppressedFindings[0].file).toBe('test/auth.test.ts');
  });

  it('does NOT suppress when pattern differs from the suppression entry', async () => {
    mockGetConfig.mockReturnValue({
      appliance: {
        tools: {
          credential_audit: {
            repo_path: '/home/weather',
            suppressed_findings: [
              { pattern: 'password_assignment', file: 'test/', reason: 'test fixtures' },
            ],
          },
        },
      },
    });
    mockExec.mockImplementation((cmd) => {
      if (cmd.includes('.gitignore') || cmd.includes('cat ')) return Promise.resolve(GITIGNORE_FULL);
      if (cmd.includes('AKIA')) {
        return Promise.resolve({
          stdout: grepLine('test/backup.test.ts', 99, "const k='AKIAIOSFODNN7EXAMPLE';"),
          stderr: '',
          exitCode: 0,
        });
      }
      return Promise.resolve(NO_MATCH);
    });

    const result = await handler();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].pattern).toBe('aws_access_key');
    expect(result.suppressedFindings).toHaveLength(0);
  });
});
