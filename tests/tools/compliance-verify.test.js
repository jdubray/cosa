'use strict';

jest.mock('../../src/ssh-backend');
jest.mock('../../config/cosa.config');
jest.mock('../../src/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }),
}));

const sshBackend = require('../../src/ssh-backend');
const { getConfig } = require('../../config/cosa.config');
const { handler, name, riskLevel } = require('../../src/tools/compliance-verify');

const DEFAULT_CONFIG = {
  appliance: {
    monitoring: { known_ports: [22, 443, 3000] },
    tools: {
      compliance_verify: {
        sensitive_files: ['/home/weather/.env', '/home/weather/merchant.db'],
      },
    },
  },
};

const mockExec = jest.fn();

beforeEach(() => {
  sshBackend.isConnected = jest.fn().mockReturnValue(true);
  sshBackend.exec = mockExec;
  getConfig.mockReturnValue(DEFAULT_CONFIG);
  mockExec.mockReset();
});

function ok(stdout) {
  return { exitCode: 0, stdout, stderr: '' };
}

function notFound() {
  return { exitCode: 1, stdout: '', stderr: '' };
}

/**
 * Set up mockExec to route SSH commands by content.
 * Routes are checked in order — first match wins.
 * Use includes strings that won't collide: 'stat -c' not 'stat' (netstat contains 'stat').
 */
function setupExec(routes, defaultResult = { exitCode: 0, stdout: '', stderr: '' }) {
  mockExec.mockReset();
  mockExec.mockImplementation((cmd) => {
    for (const route of routes) {
      if (cmd.includes(route.includes)) return Promise.resolve(route.result);
    }
    return Promise.resolve(defaultResult);
  });
}

/** Build a complete happy-path route table, overriding individual commands as needed. */
function happyRoutes({
  passwdAuth  = ok('PasswordAuthentication no'),
  permitRoot  = ok('PermitRootLogin no'),
  maxAuth     = ok('MaxAuthTries 3'),
  stat        = ok('600 /home/weather/.env\n600 /home/weather/merchant.db'),
  ss          = ok('LISTEN 0 128 0.0.0.0:22 *:*\nLISTEN 0 128 0.0.0.0:443 *:*\nLISTEN 0 128 0.0.0.0:3000 *:*'),
} = {}) {
  // Order matters: 'PasswordAuthentication' and 'PermitRootLogin' and 'MaxAuthTries'
  // are distinct. 'stat -c' is used (not 'stat') to avoid matching 'netstat'.
  // 'ss -tlnp' is explicit.
  return [
    { includes: 'PasswordAuthentication', result: passwdAuth },
    { includes: 'PermitRootLogin',         result: permitRoot },
    { includes: 'MaxAuthTries',            result: maxAuth },
    { includes: 'stat -c',                 result: stat },
    { includes: 'ss -tlnp',               result: ss },
  ];
}

// ---------------------------------------------------------------------------
// AC1: PasswordAuthentication checks
// ---------------------------------------------------------------------------

describe('AC1 – sshd_config PasswordAuthentication', () => {
  test('pass when PasswordAuthentication no', async () => {
    setupExec(happyRoutes());
    const result = await handler();
    const f = result.findings.find((x) => x.check === 'sshd_config.PasswordAuthentication');
    expect(f.status).toBe('pass');
    expect(f.evidence).toContain('no');
  });

  test('fail when PasswordAuthentication yes', async () => {
    setupExec(happyRoutes({ passwdAuth: ok('PasswordAuthentication yes') }));
    const result = await handler();
    const f = result.findings.find((x) => x.check === 'sshd_config.PasswordAuthentication');
    expect(f.status).toBe('fail');
    expect(f.evidence).toContain('"yes"');
  });

  test('warning when PasswordAuthentication not set (grep exits 1)', async () => {
    setupExec(happyRoutes({ passwdAuth: notFound() }));
    const result = await handler();
    const f = result.findings.find((x) => x.check === 'sshd_config.PasswordAuthentication');
    expect(f.status).toBe('warning');
    expect(f.evidence).toMatch(/not explicitly set/);
  });

  test('warning when only comment lines exist for PasswordAuthentication', async () => {
    setupExec(happyRoutes({ passwdAuth: ok('#PasswordAuthentication yes\n# another comment') }));
    const result = await handler();
    const f = result.findings.find((x) => x.check === 'sshd_config.PasswordAuthentication');
    expect(f.status).toBe('warning');
    expect(f.evidence).toMatch(/only as comment/);
  });
});

// ---------------------------------------------------------------------------
// AC2: PermitRootLogin checks
// ---------------------------------------------------------------------------

describe('AC2 – sshd_config PermitRootLogin', () => {
  test('pass for PermitRootLogin no', async () => {
    setupExec(happyRoutes());
    const result = await handler();
    const f = result.findings.find((x) => x.check === 'sshd_config.PermitRootLogin');
    expect(f.status).toBe('pass');
  });

  test('pass for PermitRootLogin prohibit-password', async () => {
    setupExec(happyRoutes({ permitRoot: ok('PermitRootLogin prohibit-password') }));
    const result = await handler();
    const f = result.findings.find((x) => x.check === 'sshd_config.PermitRootLogin');
    expect(f.status).toBe('pass');
  });

  test('pass for PermitRootLogin without-password (legacy alias)', async () => {
    setupExec(happyRoutes({ permitRoot: ok('PermitRootLogin without-password') }));
    const result = await handler();
    const f = result.findings.find((x) => x.check === 'sshd_config.PermitRootLogin');
    expect(f.status).toBe('pass');
  });

  test('fail for PermitRootLogin yes', async () => {
    setupExec(happyRoutes({ permitRoot: ok('PermitRootLogin yes') }));
    const result = await handler();
    const f = result.findings.find((x) => x.check === 'sshd_config.PermitRootLogin');
    expect(f.status).toBe('fail');
    expect(f.evidence).toContain('"yes"');
  });

  test('warning for PermitRootLogin forced-commands-only', async () => {
    setupExec(happyRoutes({ permitRoot: ok('PermitRootLogin forced-commands-only') }));
    const result = await handler();
    const f = result.findings.find((x) => x.check === 'sshd_config.PermitRootLogin');
    expect(f.status).toBe('warning');
  });

  test('warning when PermitRootLogin not set', async () => {
    setupExec(happyRoutes({ permitRoot: notFound() }));
    const result = await handler();
    const f = result.findings.find((x) => x.check === 'sshd_config.PermitRootLogin');
    expect(f.status).toBe('warning');
    expect(f.evidence).toMatch(/not explicitly set/);
  });
});

// ---------------------------------------------------------------------------
// AC3: MaxAuthTries checks
// ---------------------------------------------------------------------------

describe('AC3 – sshd_config MaxAuthTries', () => {
  test('pass for MaxAuthTries 3', async () => {
    setupExec(happyRoutes());
    const result = await handler();
    const f = result.findings.find((x) => x.check === 'sshd_config.MaxAuthTries');
    expect(f.status).toBe('pass');
    expect(f.evidence).toContain('3');
  });

  test('pass for MaxAuthTries 2 (stricter than required)', async () => {
    setupExec(happyRoutes({ maxAuth: ok('MaxAuthTries 2') }));
    const result = await handler();
    const f = result.findings.find((x) => x.check === 'sshd_config.MaxAuthTries');
    expect(f.status).toBe('pass');
    expect(f.evidence).toContain('at or below');
  });

  test('fail for MaxAuthTries 6', async () => {
    setupExec(happyRoutes({ maxAuth: ok('MaxAuthTries 6') }));
    const result = await handler();
    const f = result.findings.find((x) => x.check === 'sshd_config.MaxAuthTries');
    expect(f.status).toBe('fail');
    expect(f.evidence).toContain('6');
  });

  test('warning when MaxAuthTries not set', async () => {
    setupExec(happyRoutes({ maxAuth: notFound() }));
    const result = await handler();
    const f = result.findings.find((x) => x.check === 'sshd_config.MaxAuthTries');
    expect(f.status).toBe('warning');
    expect(f.evidence).toMatch(/not explicitly set/);
  });

  test('warning when only comment lines exist for MaxAuthTries', async () => {
    setupExec(happyRoutes({ maxAuth: ok('#MaxAuthTries 3') }));
    const result = await handler();
    const f = result.findings.find((x) => x.check === 'sshd_config.MaxAuthTries');
    expect(f.status).toBe('warning');
    expect(f.evidence).toMatch(/only as comment/);
  });
});

// ---------------------------------------------------------------------------
// AC4: File permissions checks
// ---------------------------------------------------------------------------

describe('AC4 – file permissions on sensitive files', () => {
  test('pass when .env and merchant.db are mode 600', async () => {
    setupExec(happyRoutes());
    const result = await handler();
    const envF = result.findings.find((x) => x.check === 'file_permissions..env');
    const dbF  = result.findings.find((x) => x.check === 'file_permissions.merchant.db');
    expect(envF.status).toBe('pass');
    expect(dbF.status).toBe('pass');
  });

  test('fail when .env is world-readable (mode 644)', async () => {
    setupExec(happyRoutes({ stat: ok('644 /home/weather/.env\n600 /home/weather/merchant.db') }));
    const result = await handler();
    const envF = result.findings.find((x) => x.check === 'file_permissions..env');
    expect(envF.status).toBe('fail');
    expect(envF.evidence).toContain('world-readable');
    expect(envF.evidence).toContain('644');
  });

  test('fail when merchant.db is world-readable (mode 604)', async () => {
    setupExec(happyRoutes({ stat: ok('600 /home/weather/.env\n604 /home/weather/merchant.db') }));
    const result = await handler();
    const dbF = result.findings.find((x) => x.check === 'file_permissions.merchant.db');
    expect(dbF.status).toBe('fail');
    expect(dbF.evidence).toContain('world-readable');
  });

  test('warning when .env is group-readable (mode 640)', async () => {
    setupExec(happyRoutes({ stat: ok('640 /home/weather/.env\n600 /home/weather/merchant.db') }));
    const result = await handler();
    const envF = result.findings.find((x) => x.check === 'file_permissions..env');
    expect(envF.status).toBe('warning');
    expect(envF.evidence).toContain('group-readable');
    expect(envF.evidence).toContain('640');
  });

  test('warning when file not found in stat output', async () => {
    // stat only returns merchant.db — .env is absent
    setupExec(happyRoutes({ stat: ok('600 /home/weather/merchant.db') }));
    const result = await handler();
    const envF = result.findings.find((x) => x.check === 'file_permissions..env');
    expect(envF.status).toBe('warning');
    expect(envF.evidence).toMatch(/not found|may not exist/);
  });
});

// ---------------------------------------------------------------------------
// AC5: Listening services checks
// ---------------------------------------------------------------------------

describe('AC5 – listening services', () => {
  test('pass when all listening ports are known', async () => {
    setupExec(happyRoutes());
    const result = await handler();
    const f = result.findings.find((x) => x.check === 'listening_services');
    expect(f.status).toBe('pass');
    expect(f.evidence).toContain('22');
  });

  test('fail when unknown port is listening', async () => {
    setupExec(happyRoutes({
      ss: ok('LISTEN 0 128 0.0.0.0:22 *:*\nLISTEN 0 128 0.0.0.0:8888 *:*'),
    }));
    const result = await handler();
    const f = result.findings.find((x) => x.check === 'listening_services');
    expect(f.status).toBe('fail');
    expect(f.evidence).toContain('8888');
    expect(f.evidence).toMatch(/Unknown listening port/);
  });

  test('pass when no ports are listening (empty ss output)', async () => {
    setupExec(happyRoutes({ ss: ok('') }));
    const result = await handler();
    const f = result.findings.find((x) => x.check === 'listening_services');
    expect(f.status).toBe('pass');
  });

  test('skips State/Proto header lines from ss output', async () => {
    setupExec(happyRoutes({
      ss: ok('State  Recv-Q  Send-Q  Local Address:Port\nLISTEN 0 128 0.0.0.0:22 *:*'),
    }));
    const result = await handler();
    const f = result.findings.find((x) => x.check === 'listening_services');
    expect(f.status).toBe('pass');
  });

  test('evidence lists all known ports when passing', async () => {
    setupExec(happyRoutes());
    const result = await handler();
    const f = result.findings.find((x) => x.check === 'listening_services');
    expect(f.evidence).toMatch(/22/);
    expect(f.evidence).toMatch(/443/);
  });
});

// ---------------------------------------------------------------------------
// AC6: Findings array shape and summary string
// ---------------------------------------------------------------------------

describe('AC6 – findings array shape and summary', () => {
  test('each finding has check, status, and evidence fields', async () => {
    setupExec(happyRoutes());
    const result = await handler();
    expect(Array.isArray(result.findings)).toBe(true);
    for (const f of result.findings) {
      expect(typeof f.check).toBe('string');
      expect(['pass', 'fail', 'warning']).toContain(f.status);
      expect(typeof f.evidence).toBe('string');
    }
  });

  test('returns pass_count, fail_count, warning_count that sum to findings.length', async () => {
    setupExec(happyRoutes());
    const result = await handler();
    expect(typeof result.pass_count).toBe('number');
    expect(typeof result.fail_count).toBe('number');
    expect(typeof result.warning_count).toBe('number');
    expect(result.pass_count + result.fail_count + result.warning_count).toBe(result.findings.length);
  });

  test('summary says "All N checks passed" when no failures or warnings', async () => {
    setupExec(happyRoutes());
    const result = await handler();
    expect(result.summary).toMatch(/All \d+ checks passed/);
    expect(result.fail_count).toBe(0);
    expect(result.warning_count).toBe(0);
  });

  test('summary includes failure count when failures exist', async () => {
    setupExec(happyRoutes({
      passwdAuth: ok('PasswordAuthentication yes'),
      permitRoot: ok('PermitRootLogin yes'),
    }));
    const result = await handler();
    expect(result.summary).toMatch(/compliance failure/);
    expect(result.fail_count).toBeGreaterThanOrEqual(2);
  });

  test('summary includes warning count when warnings exist but no failures', async () => {
    setupExec(happyRoutes({ passwdAuth: notFound() }));
    const result = await handler();
    expect(result.summary).toMatch(/warning/);
    expect(result.fail_count).toBe(0);
    expect(result.warning_count).toBeGreaterThanOrEqual(1);
  });

  test('returns checked_at ISO timestamp', async () => {
    setupExec(happyRoutes());
    const result = await handler();
    expect(typeof result.checked_at).toBe('string');
    expect(() => new Date(result.checked_at)).not.toThrow();
    expect(new Date(result.checked_at).getFullYear()).toBeGreaterThanOrEqual(2024);
  });

  test('findings include one entry per sensitive file plus sshd checks and listening_services', async () => {
    setupExec(happyRoutes());
    const result = await handler();
    // Default config has 2 sensitive files, 3 sshd checks, 1 listening_services = 6 total
    expect(result.findings.length).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// AC7: Risk level is 'read'
// ---------------------------------------------------------------------------

describe('AC7 – risk level', () => {
  test("riskLevel is 'read'", () => {
    expect(riskLevel).toBe('read');
  });

  test("name is 'compliance_verify'", () => {
    expect(name).toBe('compliance_verify');
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

// ---------------------------------------------------------------------------
// Edge: custom sensitive_files from config
// ---------------------------------------------------------------------------

describe('custom sensitive_files from config', () => {
  test('uses config-defined sensitive_files list', async () => {
    getConfig.mockReturnValue({
      appliance: {
        monitoring: { known_ports: [22] },
        tools: {
          compliance_verify: {
            sensitive_files: ['/custom/path/secret.key'],
          },
        },
      },
    });

    setupExec([
      { includes: 'PasswordAuthentication', result: ok('PasswordAuthentication no') },
      { includes: 'PermitRootLogin',         result: ok('PermitRootLogin no') },
      { includes: 'MaxAuthTries',            result: ok('MaxAuthTries 3') },
      { includes: 'stat -c',                 result: ok('600 /custom/path/secret.key') },
      { includes: 'ss -tlnp',               result: ok('LISTEN 0 128 0.0.0.0:22 *:*') },
    ]);

    const result = await handler();
    const f = result.findings.find((x) => x.check === 'file_permissions.secret.key');
    expect(f).toBeDefined();
    expect(f.status).toBe('pass');
  });
});
