'use strict';

jest.mock('../../src/ssh-backend');
jest.mock('../../src/tool-registry');
jest.mock('../../config/cosa.config');
jest.mock('../../src/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }),
}));

const sshBackend    = require('../../src/ssh-backend');
const toolRegistry  = require('../../src/tool-registry');
const { getConfig } = require('../../config/cosa.config');
const { handler, name, riskLevel } = require('../../src/tools/pci-assessment');

const DEFAULT_CONFIG = {
  appliance: {
    monitoring: { known_ports: [22, 443, 3000] },
  },
};

const mockExec = jest.fn();

beforeEach(() => {
  sshBackend.isConnected = jest.fn().mockReturnValue(true);
  sshBackend.exec = mockExec;
  getConfig.mockReturnValue(DEFAULT_CONFIG);
  mockExec.mockReset();
  // Default: dep_audit not found
  toolRegistry.dispatch = jest.fn().mockRejectedValue(Object.assign(new Error('not found'), { code: 'TOOL_NOT_FOUND' }));
});

function ok(stdout) { return { exitCode: 0, stdout, stderr: '' }; }
function empty()    { return { exitCode: 1, stdout: '', stderr: '' }; }

/**
 * Route SSH commands by content. First matching route wins.
 * Routing keys chosen to avoid substring collisions:
 *   'PasswordAuthentication' — sshd grep
 *   'SECURITY.md'           — find SECURITY.md
 *   'wc -l'                 — auth.log line count
 *   'stat -c'               — auth.log stat (CMD_AUTH_LOG_STAT only; CMD_SS is 'netstat', not 'stat -c')
 *   'awk -F:'               — duplicate UIDs
 *   'ss -tlnp'              — listening ports
 *   '/etc/passwd'           — default accounts grep
 */
function setupExec(routes, defaultResult = ok('')) {
  mockExec.mockReset();
  mockExec.mockImplementation((cmd) => {
    for (const route of routes) {
      if (cmd.includes(route.includes)) return Promise.resolve(route.result);
    }
    return Promise.resolve(defaultResult);
  });
}

/** A fully happy-path route table. Override individual entries as needed. */
function happyRoutes({
  defaultAccounts = empty(),                         // no default accounts
  ss              = ok('LISTEN 0 128 0.0.0.0:22 *:*\nLISTEN 0 128 0.0.0.0:443 *:*\nLISTEN 0 128 0.0.0.0:3000 *:*'),
  duplicateUids   = ok(''),                          // no duplicates
  passwdAuth      = ok('PasswordAuthentication no'),
  authLogLines    = ok('1200 /var/log/auth.log'),
  authLogStat     = ok('640 /var/log/auth.log'),
  securityMd      = ok('/home/weather/SECURITY.md'),
} = {}) {
  return [
    { includes: 'PasswordAuthentication', result: passwdAuth },
    { includes: 'SECURITY.md',            result: securityMd },
    { includes: 'wc -l',                  result: authLogLines },
    { includes: 'stat -c',                result: authLogStat },
    { includes: 'awk -F:',               result: duplicateUids },
    { includes: 'ss -tlnp',              result: ss },
    { includes: '/etc/passwd',            result: defaultAccounts },
  ];
}

// ---------------------------------------------------------------------------
// AC1: All 13 SAQ-A requirements covered
// ---------------------------------------------------------------------------

describe('AC1 – all 13 SAQ-A requirements covered', () => {
  const EXPECTED_IDS = ['2.1', '2.2', '6.1', '6.2', '8.1', '8.2', '8.6', '9.1', '10.1', '10.2', '10.5', '11.2', '12.1'];

  test('returns exactly 13 requirements', async () => {
    setupExec(happyRoutes());
    const result = await handler();
    expect(result.requirements.length).toBe(13);
  });

  test('contains all required requirement IDs', async () => {
    setupExec(happyRoutes());
    const result = await handler();
    const ids = result.requirements.map((r) => r.id);
    for (const expectedId of EXPECTED_IDS) {
      expect(ids).toContain(expectedId);
    }
  });

  test('each requirement has id, description, status, and evidence fields', async () => {
    setupExec(happyRoutes());
    const result = await handler();
    for (const r of result.requirements) {
      expect(typeof r.id).toBe('string');
      expect(typeof r.description).toBe('string');
      expect(['pass', 'fail', 'warning', 'manual']).toContain(r.status);
      expect(typeof r.evidence).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// AC2: Each requirement returns a valid status
// ---------------------------------------------------------------------------

describe('AC2 – each requirement status is pass|fail|warning|manual', () => {
  test('all statuses are valid enum values', async () => {
    setupExec(happyRoutes());
    const result = await handler();
    const valid = new Set(['pass', 'fail', 'warning', 'manual']);
    for (const r of result.requirements) {
      expect(valid.has(r.status)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// AC3: Manual checks are flagged with a clear note
// ---------------------------------------------------------------------------

describe('AC3 – manual checks are flagged, not auto-failed', () => {
  test('9.1 (physical access) is always manual', async () => {
    setupExec(happyRoutes());
    const result = await handler();
    const r = result.requirements.find((x) => x.id === '9.1');
    expect(r.status).toBe('manual');
    expect(r.evidence).toMatch(/cannot be verified remotely/i);
    expect(r.recommendation).toBeTruthy();
  });

  test('11.2 (external vulnerability scans) is always manual', async () => {
    setupExec(happyRoutes());
    const result = await handler();
    const r = result.requirements.find((x) => x.id === '11.2');
    expect(r.status).toBe('manual');
    expect(r.recommendation).toMatch(/ASV|quarterly/);
  });

  test('8.6 (MFA) is always manual', async () => {
    setupExec(happyRoutes());
    const result = await handler();
    const r = result.requirements.find((x) => x.id === '8.6');
    expect(r.status).toBe('manual');
    expect(r.recommendation).toBeTruthy();
  });

  test('manual items do not appear in actionItems', async () => {
    setupExec(happyRoutes());
    const result = await handler();
    const manualIds = result.requirements
      .filter((r) => r.status === 'manual')
      .map((r) => r.id);
    for (const id of manualIds) {
      const inActionItems = result.actionItems.some((a) => a.startsWith(`[${id}]`));
      expect(inActionItems).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// AC4: overallStatus derivation
// ---------------------------------------------------------------------------

describe('AC4 – overallStatus', () => {
  test("'compliant' when all automated checks pass or are manual", async () => {
    setupExec(happyRoutes());
    toolRegistry.dispatch = jest.fn().mockResolvedValue({ vulnerabilities: [], auditClean: true });
    const result = await handler();
    expect(result.overallStatus).toBe('compliant');
  });

  test("'non_compliant' when any automated check fails", async () => {
    // Trigger 2.1 fail: default account 'pi' found
    setupExec(happyRoutes({ defaultAccounts: ok('pi:x:1000:1000::/home/pi:/bin/bash') }));
    const result = await handler();
    expect(result.overallStatus).toBe('non_compliant');
  });

  test("'needs_review' when warnings exist but no failures", async () => {
    // Trigger 12.1 warning: SECURITY.md not found
    setupExec(happyRoutes({ securityMd: ok('') }));
    // Ensure no failures
    toolRegistry.dispatch = jest.fn().mockResolvedValue({ vulnerabilities: [], auditClean: true });
    const result = await handler();
    expect(result.overallStatus).toBe('needs_review');
  });

  test('manual items do not affect overallStatus', async () => {
    // All automated checks pass; manual items (9.1, 11.2, 8.6) are present
    setupExec(happyRoutes());
    toolRegistry.dispatch = jest.fn().mockResolvedValue({ vulnerabilities: [], auditClean: true });
    const result = await handler();
    const manualItems = result.requirements.filter((r) => r.status === 'manual');
    expect(manualItems.length).toBeGreaterThan(0);
    expect(result.overallStatus).toBe('compliant');
  });
});

// ---------------------------------------------------------------------------
// AC5: actionItems for fail and warning items
// ---------------------------------------------------------------------------

describe('AC5 – actionItems', () => {
  test('actionItems is empty when all automated checks pass', async () => {
    setupExec(happyRoutes());
    toolRegistry.dispatch = jest.fn().mockResolvedValue({ vulnerabilities: [], auditClean: true });
    const result = await handler();
    expect(result.actionItems).toEqual([]);
  });

  test('actionItems contains entry for each fail/warning requirement', async () => {
    // Trigger 2.1 fail and 12.1 warning
    setupExec(happyRoutes({
      defaultAccounts: ok('pi:x:1000:1000::/home/pi:/bin/bash'),
      securityMd:      ok(''),
    }));
    const result = await handler();
    const has2_1  = result.actionItems.some((a) => a.startsWith('[2.1]'));
    const has12_1 = result.actionItems.some((a) => a.startsWith('[12.1]'));
    expect(has2_1).toBe(true);
    expect(has12_1).toBe(true);
  });

  test('actionItems strings include recommendation text', async () => {
    setupExec(happyRoutes({ defaultAccounts: ok('pi:x:1000:1000::/home/pi:/bin/bash') }));
    const result = await handler();
    const item = result.actionItems.find((a) => a.startsWith('[2.1]'));
    expect(item).toMatch(/Rename|disable/i);
  });
});

// ---------------------------------------------------------------------------
// AC6: assessmentDate and scope
// ---------------------------------------------------------------------------

describe('AC6 – assessmentDate and scope', () => {
  test('scope is SAQ-A', async () => {
    setupExec(happyRoutes());
    const result = await handler();
    expect(result.scope).toBe('SAQ-A');
  });

  test('assessmentDate is a valid ISO 8601 timestamp', async () => {
    setupExec(happyRoutes());
    const result = await handler();
    expect(typeof result.assessmentDate).toBe('string');
    expect(() => new Date(result.assessmentDate)).not.toThrow();
    expect(new Date(result.assessmentDate).getFullYear()).toBeGreaterThanOrEqual(2024);
  });
});

// ---------------------------------------------------------------------------
// AC7: Risk level is 'read'
// ---------------------------------------------------------------------------

describe('AC7 – risk level', () => {
  test("riskLevel is 'read'", () => {
    expect(riskLevel).toBe('read');
  });

  test("name is 'pci_assessment'", () => {
    expect(name).toBe('pci_assessment');
  });
});

// ---------------------------------------------------------------------------
// Per-requirement: 2.1 – default accounts
// ---------------------------------------------------------------------------

describe('REQ 2.1 – no default vendor-supplied passwords', () => {
  test('pass when no default accounts found (exitCode 1, empty stdout)', async () => {
    setupExec(happyRoutes({ defaultAccounts: empty() }));
    const result = await handler();
    const r = result.requirements.find((x) => x.id === '2.1');
    expect(r.status).toBe('pass');
  });

  test('fail when default account pi is present', async () => {
    setupExec(happyRoutes({ defaultAccounts: ok('pi:x:1000:1000::/home/pi:/bin/bash') }));
    const result = await handler();
    const r = result.requirements.find((x) => x.id === '2.1');
    expect(r.status).toBe('fail');
    expect(r.evidence).toContain('pi');
    expect(r.recommendation).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Per-requirement: 2.2 – only necessary services
// ---------------------------------------------------------------------------

describe('REQ 2.2 – only necessary services enabled', () => {
  test('pass when all listening ports are in known set', async () => {
    setupExec(happyRoutes());
    const result = await handler();
    const r = result.requirements.find((x) => x.id === '2.2');
    expect(r.status).toBe('pass');
  });

  test('fail when unknown port is listening', async () => {
    setupExec(happyRoutes({ ss: ok('LISTEN 0 128 0.0.0.0:22 *:*\nLISTEN 0 128 0.0.0.0:9999 *:*') }));
    const result = await handler();
    const r = result.requirements.find((x) => x.id === '2.2');
    expect(r.status).toBe('fail');
    expect(r.evidence).toContain('9999');
  });
});

// ---------------------------------------------------------------------------
// Per-requirement: 6.1 / 6.2 – dep_audit integration
// ---------------------------------------------------------------------------

describe('REQ 6.1 / 6.2 – dependency audit', () => {
  test('6.1 and 6.2 are warning when dep_audit tool not found', async () => {
    setupExec(happyRoutes());
    // toolRegistry.dispatch throws TOOL_NOT_FOUND by default in beforeEach
    const result = await handler();
    const r61 = result.requirements.find((x) => x.id === '6.1');
    const r62 = result.requirements.find((x) => x.id === '6.2');
    expect(r61.status).toBe('warning');
    expect(r62.status).toBe('warning');
  });

  test('6.1 and 6.2 pass when dep_audit finds no vulnerabilities', async () => {
    setupExec(happyRoutes());
    toolRegistry.dispatch = jest.fn().mockResolvedValue({ vulnerabilities: [], auditClean: true });
    const result = await handler();
    const r61 = result.requirements.find((x) => x.id === '6.1');
    const r62 = result.requirements.find((x) => x.id === '6.2');
    expect(r61.status).toBe('pass');
    expect(r62.status).toBe('pass');
  });

  test('6.1 fails when dep_audit finds vulnerabilities', async () => {
    setupExec(happyRoutes());
    toolRegistry.dispatch = jest.fn().mockResolvedValue({
      vulnerabilities: [{ pkg: 'lodash', severity: 'high' }],
      auditClean: false,
    });
    const result = await handler();
    const r61 = result.requirements.find((x) => x.id === '6.1');
    expect(r61.status).toBe('fail');
  });

  test('6.2 fails when bun audit is not clean', async () => {
    setupExec(happyRoutes());
    toolRegistry.dispatch = jest.fn().mockResolvedValue({
      vulnerabilities: [],
      auditClean: false,
    });
    const result = await handler();
    const r62 = result.requirements.find((x) => x.id === '6.2');
    expect(r62.status).toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// Per-requirement: 8.1 – unique user IDs
// ---------------------------------------------------------------------------

describe('REQ 8.1 – unique user IDs', () => {
  test('pass when no duplicate UIDs', async () => {
    setupExec(happyRoutes({ duplicateUids: ok('') }));
    const result = await handler();
    const r = result.requirements.find((x) => x.id === '8.1');
    expect(r.status).toBe('pass');
  });

  test('fail when duplicate UIDs detected', async () => {
    setupExec(happyRoutes({ duplicateUids: ok('weather 1001') }));
    const result = await handler();
    const r = result.requirements.find((x) => x.id === '8.1');
    expect(r.status).toBe('fail');
    expect(r.evidence).toContain('weather');
  });
});

// ---------------------------------------------------------------------------
// Per-requirement: 8.2 – strong authentication
// ---------------------------------------------------------------------------

describe('REQ 8.2 – strong authentication enforced', () => {
  test('pass when PasswordAuthentication no', async () => {
    setupExec(happyRoutes({ passwdAuth: ok('PasswordAuthentication no') }));
    const result = await handler();
    const r = result.requirements.find((x) => x.id === '8.2');
    expect(r.status).toBe('pass');
  });

  test('warning when PasswordAuthentication not set', async () => {
    setupExec(happyRoutes({ passwdAuth: empty() }));
    const result = await handler();
    const r = result.requirements.find((x) => x.id === '8.2');
    expect(r.status).toBe('warning');
  });

  test('fail when PasswordAuthentication yes', async () => {
    setupExec(happyRoutes({ passwdAuth: ok('PasswordAuthentication yes') }));
    const result = await handler();
    const r = result.requirements.find((x) => x.id === '8.2');
    expect(r.status).toBe('fail');
    expect(r.evidence).toContain('"yes"');
  });
});

// ---------------------------------------------------------------------------
// Per-requirement: 10.1 – audit log all access
// ---------------------------------------------------------------------------

describe('REQ 10.1 – audit log all access', () => {
  test('pass when auth.log has entries', async () => {
    setupExec(happyRoutes({ authLogLines: ok('1200 /var/log/auth.log') }));
    const result = await handler();
    const r = result.requirements.find((x) => x.id === '10.1');
    expect(r.status).toBe('pass');
    expect(r.evidence).toContain('1200');
  });

  test('warning when auth.log not found', async () => {
    setupExec(happyRoutes({ authLogLines: ok('0 not-found') }));
    const result = await handler();
    const r = result.requirements.find((x) => x.id === '10.1');
    expect(r.status).toBe('warning');
  });

  test('warning when auth.log output is empty', async () => {
    setupExec(happyRoutes({ authLogLines: ok('') }));
    const result = await handler();
    const r = result.requirements.find((x) => x.id === '10.1');
    expect(r.status).toBe('warning');
  });
});

// ---------------------------------------------------------------------------
// Per-requirement: 10.2 – log all admin actions (always pass)
// ---------------------------------------------------------------------------

describe('REQ 10.2 – log all admin actions', () => {
  test('always passes (COSA session.db logging is inherent)', async () => {
    setupExec(happyRoutes());
    const result = await handler();
    const r = result.requirements.find((x) => x.id === '10.2');
    expect(r.status).toBe('pass');
    expect(r.evidence).toMatch(/session\.db|SAM/);
  });
});

// ---------------------------------------------------------------------------
// Per-requirement: 10.5 – logs protected from modification
// ---------------------------------------------------------------------------

describe('REQ 10.5 – logs protected from modification', () => {
  test('pass when auth.log has safe permissions (640)', async () => {
    setupExec(happyRoutes({ authLogStat: ok('640 /var/log/auth.log') }));
    const result = await handler();
    const r = result.requirements.find((x) => x.id === '10.5');
    expect(r.status).toBe('pass');
    expect(r.evidence).toContain('640');
  });

  test('fail when auth.log is world-writable (666)', async () => {
    setupExec(happyRoutes({ authLogStat: ok('666 /var/log/auth.log') }));
    const result = await handler();
    const r = result.requirements.find((x) => x.id === '10.5');
    expect(r.status).toBe('fail');
    expect(r.evidence).toContain('world-writable');
  });

  test('warning when auth.log is group-writable (660)', async () => {
    setupExec(happyRoutes({ authLogStat: ok('660 /var/log/auth.log') }));
    const result = await handler();
    const r = result.requirements.find((x) => x.id === '10.5');
    expect(r.status).toBe('warning');
    expect(r.evidence).toContain('group-writable');
  });

  test('warning when auth.log stat returns not-found', async () => {
    setupExec(happyRoutes({ authLogStat: ok('not-found /var/log/auth.log') }));
    const result = await handler();
    const r = result.requirements.find((x) => x.id === '10.5');
    expect(r.status).toBe('warning');
  });
});

// ---------------------------------------------------------------------------
// Per-requirement: 12.1 – security policy documented
// ---------------------------------------------------------------------------

describe('REQ 12.1 – security policy documented', () => {
  test('pass when SECURITY.md found', async () => {
    setupExec(happyRoutes({ securityMd: ok('/home/weather/SECURITY.md') }));
    const result = await handler();
    const r = result.requirements.find((x) => x.id === '12.1');
    expect(r.status).toBe('pass');
    expect(r.evidence).toContain('SECURITY.md');
  });

  test('warning when SECURITY.md not found (empty find output)', async () => {
    setupExec(happyRoutes({ securityMd: ok('') }));
    const result = await handler();
    const r = result.requirements.find((x) => x.id === '12.1');
    expect(r.status).toBe('warning');
    expect(r.recommendation).toMatch(/SECURITY\.md/);
  });
});

// ---------------------------------------------------------------------------
// Edge: SSH not connected
// ---------------------------------------------------------------------------

describe('SSH not connected', () => {
  test('throws when SSH is not connected', async () => {
    sshBackend.isConnected = jest.fn().mockReturnValue(false);
    await expect(handler()).rejects.toThrow('SSH not connected');
  });
});
