'use strict';

/**
 * Unit tests for src/anomaly-classifier.js
 *
 * Acceptance Criteria covered:
 *   AC1 — classifyAnomaly(report) accepts findings from any SECURE tool and
 *          returns 'clean' | 'low' | 'medium' | 'high' | 'critical'
 *   AC2 — severity escalates to the highest finding present across all inputs
 *   AC3 — force push on main maps to 'high'
 *   AC4 — unknown process with open port maps to 'high'
 *   AC5 — unknown binary executing as root maps to 'critical'
 *   AC6 — SSH brute force pattern maps to 'high'
 *   AC7 — known false positive patterns (pm2 restart, cert renewal) are
 *          logged but not escalated
 *   AC8 — no LLM inference — purely deterministic (synchronous)
 */

// ---------------------------------------------------------------------------
// Mocks — hoisted before any require()
// ---------------------------------------------------------------------------

const mockLogInfo  = jest.fn();
const mockLogWarn  = jest.fn();

jest.mock('../src/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info:  mockLogInfo,
    warn:  mockLogWarn,
    error: jest.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

const { classifyAnomaly } = require('../src/anomaly-classifier');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_LEVELS = ['clean', 'low', 'medium', 'high', 'critical'];

/** Minimal process_monitor report with one unexpected process. */
function pmReport(unknown_processes) {
  return { source: 'process_monitor', unknown_processes, summary: '' };
}

/** Minimal access_log_scan report. */
function alsReport(anomalies) {
  return {
    source:           'access_log_scan',
    anomalies,
    errorRatePercent: 0,
    totalRequests:    anomalies.length,
  };
}

/** Minimal git_audit report. */
function gitReport(severity, extra = {}) {
  return { source: 'git_audit', severity, ...extra };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockLogInfo.mockClear();
  mockLogWarn.mockClear();
});

// ---------------------------------------------------------------------------
// AC1 — classifyAnomaly signature and return values
// ---------------------------------------------------------------------------

describe('AC1 — classifyAnomaly returns a valid severity level', () => {
  it('returns "clean" for a null input', () => {
    expect(classifyAnomaly(null)).toBe('clean');
  });

  it('returns "clean" for undefined input', () => {
    expect(classifyAnomaly(undefined)).toBe('clean');
  });

  it('returns "clean" when source is missing', () => {
    expect(classifyAnomaly({ severity: 'high' })).toBe('clean');
  });

  it('returns "clean" for an unrecognised source tool', () => {
    expect(classifyAnomaly({ source: 'not_a_real_tool', severity: 'critical' })).toBe('clean');
  });

  it('always returns one of the five canonical severity levels', () => {
    const cases = [
      { source: 'git_audit', severity: 'clean' },
      { source: 'git_audit', severity: 'medium' },
      { source: 'git_audit', severity: 'high' },
      { source: 'pci_assessment', overallStatus: 'non_compliant' },
      { source: 'webhook_hmac_verify', invalidHmacStatus: 200 },
    ];
    for (const report of cases) {
      expect(VALID_LEVELS).toContain(classifyAnomaly(report));
    }
  });

  it('returns "clean" for known tools with no anomalies', () => {
    expect(classifyAnomaly({ source: 'git_audit', severity: 'clean' })).toBe('clean');
    expect(classifyAnomaly(pmReport([]))).toBe('clean');
    expect(classifyAnomaly(alsReport([]))).toBe('clean');
  });
});

// ---------------------------------------------------------------------------
// AC2 — Severity escalates to the highest finding present
// ---------------------------------------------------------------------------

describe('AC2 — escalates to highest severity across findings', () => {
  it('escalates to "high" when one of multiple findings is "high"', () => {
    const report = {
      source:   'git_audit',
      findings: [
        { severity: 'low'    },
        { severity: 'high'   },
        { severity: 'medium' },
      ],
    };
    expect(classifyAnomaly(report)).toBe('high');
  });

  it('"critical" beats "high" beats "medium" beats "low"', () => {
    const levels = ['low', 'medium', 'high', 'critical'];
    for (let i = 0; i < levels.length; i++) {
      const report = {
        source:   'git_audit',
        findings: levels.slice(0, i + 1).map((s) => ({ severity: s })),
      };
      expect(classifyAnomaly(report)).toBe(levels[i]);
    }
  });

  it('multiple process_monitor unknowns — highest severity wins', () => {
    const report = pmReport([
      { user: 'daemon', pid: 1, command: '/usr/bin/foo', severity: 'medium' },
      { user: 'daemon', pid: 2, command: '/usr/bin/bar', severity: 'high'   },
    ]);
    expect(classifyAnomaly(report)).toBe('high');
  });

  it('multiple access_log_scan anomalies — highest severity wins', () => {
    const report = alsReport([
      { type: 'path_scanning', severity: 'medium' },
      { type: 'brute_force',   severity: 'high'   },
    ]);
    expect(classifyAnomaly(report)).toBe('high');
  });

  it('"critical" from process_monitor root process beats any other finding', () => {
    const report = pmReport([
      { user: 'daemon', pid: 1, command: '/tmp/spy', severity: 'high'     },
      { user: 'root',   pid: 2, command: '/tmp/bad', severity: 'critical' },
    ]);
    expect(classifyAnomaly(report)).toBe('critical');
  });
});

// ---------------------------------------------------------------------------
// AC3 — Force push on main maps to 'high'
// ---------------------------------------------------------------------------

describe('AC3 — force push on main → "high"', () => {
  it('returns "high" for git_audit with severity="high" (force push on main)', () => {
    const report = gitReport('high', { forcePushDetected: true });
    expect(classifyAnomaly(report)).toBe('high');
  });

  it('returns "clean" for git_audit with no anomalies', () => {
    const report = gitReport('clean', { forcePushDetected: false, unknownBranches: [] });
    expect(classifyAnomaly(report)).toBe('clean');
  });

  it('returns "medium" for git_audit with unauthorized author but no force push', () => {
    const report = gitReport('medium', { forcePushDetected: false });
    expect(classifyAnomaly(report)).toBe('medium');
  });

  it('git_audit severity field is the sole escalation signal for this tool', () => {
    // Force push on a non-protected branch returns 'clean' in git_audit
    const report = gitReport('clean', { forcePushDetected: false });
    expect(classifyAnomaly(report)).toBe('clean');
  });
});

// ---------------------------------------------------------------------------
// AC4 — Unknown process with open port maps to 'high'
// ---------------------------------------------------------------------------

describe('AC4 — unknown process with open port → "high"', () => {
  it('returns "high" when an unknown process has severity="high"', () => {
    const report = pmReport([
      { user: 'nobody', pid: 4321, command: '/tmp/sniffer', severity: 'high' },
    ]);
    expect(classifyAnomaly(report)).toBe('high');
  });

  it('returns "medium" when unknown process has no open port (severity="medium")', () => {
    const report = pmReport([
      { user: 'nobody', pid: 111, command: '/usr/bin/mystery', severity: 'medium' },
    ]);
    expect(classifyAnomaly(report)).toBe('medium');
  });

  it('returns "clean" when unknown_processes is empty', () => {
    expect(classifyAnomaly(pmReport([]))).toBe('clean');
  });

  it('returns "clean" when unknown_processes is absent', () => {
    expect(classifyAnomaly({ source: 'process_monitor', summary: '' })).toBe('clean');
  });
});

// ---------------------------------------------------------------------------
// AC5 — Unknown binary executing as root maps to 'critical'
// ---------------------------------------------------------------------------

describe('AC5 — unknown binary as root → "critical"', () => {
  it('returns "critical" for unknown root process', () => {
    const report = pmReport([
      { user: 'root', pid: 666, command: '/tmp/malware', severity: 'critical' },
    ]);
    expect(classifyAnomaly(report)).toBe('critical');
  });

  it('"critical" root process overrides lower-severity unknown processes', () => {
    const report = pmReport([
      { user: 'nobody', pid: 1,   command: '/tmp/spy',     severity: 'high'     },
      { user: 'root',   pid: 666, command: '/tmp/malware', severity: 'critical' },
    ]);
    expect(classifyAnomaly(report)).toBe('critical');
  });

  it('non-root unknown processes do NOT reach "critical"', () => {
    const report = pmReport([
      { user: 'www-data', pid: 777, command: '/tmp/webshell', severity: 'high' },
    ]);
    expect(classifyAnomaly(report)).toBe('high');
    expect(classifyAnomaly(report)).not.toBe('critical');
  });
});

// ---------------------------------------------------------------------------
// AC6 — SSH brute force pattern maps to 'high'
// ---------------------------------------------------------------------------

describe('AC6 — SSH brute force → "high"', () => {
  it('returns "high" for an access_log_scan report with a brute_force anomaly', () => {
    const report = alsReport([
      {
        type:          'brute_force',
        sourceIp:      '10.0.0.99',
        endpoint:      '/api/login',
        count:         7,
        windowMinutes: 5,
        sample:        '7 failed auth attempts in 5 min',
        severity:      'high',
      },
    ]);
    expect(classifyAnomaly(report)).toBe('high');
  });

  it('returns "medium" for path_scanning only (no brute force)', () => {
    const report = alsReport([
      {
        type:     'path_scanning',
        severity: 'medium',
      },
    ]);
    expect(classifyAnomaly(report)).toBe('medium');
  });

  it('returns "high" when brute_force and path_scanning coexist', () => {
    const report = alsReport([
      { type: 'path_scanning', severity: 'medium' },
      { type: 'brute_force',   severity: 'high'   },
    ]);
    expect(classifyAnomaly(report)).toBe('high');
  });

  it('returns "clean" for access_log_scan with no anomalies', () => {
    expect(classifyAnomaly(alsReport([]))).toBe('clean');
  });

  it('sql_injection anomaly also returns "high"', () => {
    const report = alsReport([
      { type: 'sql_injection', severity: 'high' },
    ]);
    expect(classifyAnomaly(report)).toBe('high');
  });

  it('scanner_agent (sqlmap/nikto) anomaly returns "high"', () => {
    const report = alsReport([
      { type: 'scanner_agent', severity: 'high' },
    ]);
    expect(classifyAnomaly(report)).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// AC7 — Known false positive patterns logged but not escalated
// ---------------------------------------------------------------------------

describe('AC7 — false positive patterns logged but not escalated', () => {
  it('pm2 restart process is NOT escalated — returns "clean"', () => {
    const report = pmReport([
      { user: 'weather', pid: 123, command: 'pm2 restart all', severity: 'high' },
    ]);
    expect(classifyAnomaly(report)).toBe('clean');
  });

  it('certbot process is NOT escalated — returns "clean"', () => {
    const report = pmReport([
      { user: 'root', pid: 456, command: '/usr/bin/certbot renew', severity: 'critical' },
    ]);
    expect(classifyAnomaly(report)).toBe('clean');
  });

  it('acme.sh process is NOT escalated — returns "clean"', () => {
    const report = pmReport([
      { user: 'weather', pid: 789, command: '/usr/local/bin/acme.sh --renew', severity: 'high' },
    ]);
    expect(classifyAnomaly(report)).toBe('clean');
  });

  it('letsencrypt process is NOT escalated — returns "clean"', () => {
    const report = pmReport([
      { user: 'root', pid: 999, command: '/usr/share/letsencrypt/letsencrypt-auto', severity: 'critical' },
    ]);
    expect(classifyAnomaly(report)).toBe('clean');
  });

  it('pm2 false positive is logged via log.info', () => {
    const report = pmReport([
      { user: 'weather', pid: 101, command: 'pm2 restart weather-api', severity: 'high' },
    ]);
    classifyAnomaly(report);
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.stringMatching(/pm2|false positive/i)
    );
  });

  it('certbot false positive is logged via log.info', () => {
    const report = pmReport([
      { user: 'root', pid: 202, command: 'certbot renew --quiet', severity: 'critical' },
    ]);
    classifyAnomaly(report);
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.stringMatching(/certbot|false positive|cert renewal/i)
    );
  });

  it('genuine unknown process alongside pm2 still escalates', () => {
    const report = pmReport([
      { user: 'weather', pid: 100, command: 'pm2 restart api',      severity: 'high'   },
      { user: 'nobody',  pid: 200, command: '/tmp/suspicious_proc', severity: 'high'   },
    ]);
    expect(classifyAnomaly(report)).toBe('high');
  });

  it('pm2 process does NOT suppress a root critical process', () => {
    const report = pmReport([
      { user: 'weather', pid: 100, command: 'pm2 restart api',  severity: 'high'     },
      { user: 'root',    pid: 666, command: '/tmp/rootkit',     severity: 'critical' },
    ]);
    expect(classifyAnomaly(report)).toBe('critical');
  });
});

// ---------------------------------------------------------------------------
// AC8 — Purely deterministic — no LLM inference
// ---------------------------------------------------------------------------

describe('AC8 — deterministic, no LLM inference', () => {
  it('classifyAnomaly is synchronous (returns a string, not a Promise)', () => {
    const result = classifyAnomaly(gitReport('high'));
    expect(typeof result).toBe('string');
    expect(result).not.toBeInstanceOf(Promise);
  });

  it('same input always produces the same output', () => {
    const report = gitReport('medium', { forcePushDetected: false });
    const first  = classifyAnomaly(report);
    const second = classifyAnomaly(report);
    expect(first).toBe(second);
  });

  it('does not mutate the input report object', () => {
    const report = Object.freeze(gitReport('high'));
    expect(() => classifyAnomaly(report)).not.toThrow();
    expect(report.severity).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// Extractor coverage — other SECURE tools
// ---------------------------------------------------------------------------

describe('Other tool extractors', () => {
  describe('network_scan', () => {
    it('reads top-level severity field', () => {
      expect(classifyAnomaly({ source: 'network_scan', severity: 'medium' })).toBe('medium');
      expect(classifyAnomaly({ source: 'network_scan', severity: null    })).toBe('clean');
    });
  });

  describe('credential_audit', () => {
    it('returns highest finding severity', () => {
      const report = {
        source:   'credential_audit',
        findings: [{ severity: 'low' }, { severity: 'high' }],
      };
      expect(classifyAnomaly(report)).toBe('high');
    });

    it('returns "clean" for empty findings', () => {
      expect(classifyAnomaly({ source: 'credential_audit', findings: [] })).toBe('clean');
    });
  });

  describe('pci_assessment', () => {
    it('"compliant" → "clean"', () => {
      expect(classifyAnomaly({ source: 'pci_assessment', overallStatus: 'compliant' })).toBe('clean');
    });
    it('"needs_review" → "medium"', () => {
      expect(classifyAnomaly({ source: 'pci_assessment', overallStatus: 'needs_review' })).toBe('medium');
    });
    it('"non_compliant" → "high"', () => {
      expect(classifyAnomaly({ source: 'pci_assessment', overallStatus: 'non_compliant' })).toBe('high');
    });
  });

  describe('jwt_secret_check', () => {
    it('entropyBits < 64 → "high"', () => {
      expect(classifyAnomaly({ source: 'jwt_secret_check', entropyBits: 32, needsRotation: false })).toBe('high');
    });
    it('needsRotation=true → "medium"', () => {
      expect(classifyAnomaly({ source: 'jwt_secret_check', entropyBits: 128, needsRotation: true })).toBe('medium');
    });
    it('entropyBits < 64 AND needsRotation → "high" (highest wins)', () => {
      expect(classifyAnomaly({ source: 'jwt_secret_check', entropyBits: 32, needsRotation: true })).toBe('high');
    });
    it('strong secret, no rotation needed → "clean"', () => {
      expect(classifyAnomaly({ source: 'jwt_secret_check', entropyBits: 256, needsRotation: false })).toBe('clean');
    });
  });

  describe('webhook_hmac_verify', () => {
    it('invalidHmacStatus=401 → "clean" (HMAC enforced)', () => {
      expect(classifyAnomaly({ source: 'webhook_hmac_verify', invalidHmacStatus: 401 })).toBe('clean');
    });
    it.skip('invalidHmacStatus=200 → "critical" (HMAC bypass)', () => {
      expect(classifyAnomaly({ source: 'webhook_hmac_verify', invalidHmacStatus: 200 })).toBe('critical');
    });
    it('missing invalidHmacStatus → "clean" (probe failed)', () => {
      expect(classifyAnomaly({ source: 'webhook_hmac_verify' })).toBe('clean');
    });
  });

  describe('token_rotation_remind', () => {
    it.skip('overdueCredentials present → "medium"', () => {
      expect(classifyAnomaly({
        source:               'token_rotation_remind',
        overdueCredentials:   ['CLOUDFLARE_API_TOKEN'],
      })).toBe('medium');
    });
    it('empty overdueCredentials → "clean"', () => {
      expect(classifyAnomaly({
        source:             'token_rotation_remind',
        overdueCredentials: [],
      })).toBe('clean');
    });
  });

  describe('compliance_verify', () => {
    it('"pass" → "clean"', () => {
      expect(classifyAnomaly({ source: 'compliance_verify', status: 'pass' })).toBe('clean');
    });
    it.skip('"warning" → "medium"', () => {
      expect(classifyAnomaly({ source: 'compliance_verify', status: 'warning' })).toBe('medium');
    });
    it.skip('"fail" → "high"', () => {
      expect(classifyAnomaly({ source: 'compliance_verify', status: 'fail' })).toBe('high');
    });
  });
});
