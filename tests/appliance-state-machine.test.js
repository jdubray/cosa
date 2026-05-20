'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const { _resetConfig }          = require('../config/cosa.config');
const { runMigrations, closeDb, getDb } = require('../src/session-store');
const asm = require('../src/appliance-state-machine');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_ENV = {
  ANTHROPIC_API_KEY:      'sk-ant-test',
  COSA_EMAIL_ADDRESS:     'cosa@example.com',
  COSA_EMAIL_IMAP_HOST:   'imap.example.com',
  COSA_EMAIL_IMAP_PORT:   '993',
  COSA_EMAIL_SMTP_HOST:   'smtp.example.com',
  COSA_EMAIL_SMTP_PORT:   '587',
  COSA_EMAIL_USERNAME:    'cosa@example.com',
  COSA_EMAIL_APP_PASSWORD:'test-app-password',
  COSA_CREDENTIAL_KEY:    'test-passphrase-for-unit-tests',
};

const VALID_YAML = `
appliance:
  name: "Test POS"
  timezone: "UTC"
ssh:
  host: "192.168.1.10"
  port: 22
  user: "baanbaan"
  key_path: "/home/cosa/.ssh/id_test"
operator:
  email: "owner@example.com"
  approval_timeout_minutes: 30
`;

let tmpDir;
let restoreEnv;
let originalCwd;

/** Wait one event-loop tick for SAM intent to propagate. */
const tick = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms));

beforeEach(() => {
  _resetConfig();
  closeDb();
  asm.close();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosa-asm-test-'));
  fs.mkdirSync(path.join(tmpDir, 'config'));
  fs.writeFileSync(path.join(tmpDir, 'config', 'appliance.yaml'), VALID_YAML, 'utf8');

  originalCwd = process.cwd;
  process.cwd = () => tmpDir;

  const saved = {};
  Object.entries(VALID_ENV).forEach(([k, v]) => {
    saved[k] = process.env[k];
    process.env[k] = v;
  });
  restoreEnv = () => Object.entries(VALID_ENV).forEach(([k]) => {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  });

  runMigrations(); // creates session.db; ASM migrations run inside init()
});

afterEach(() => {
  asm.close();
  closeDb();
  process.cwd = originalCwd;
  restoreEnv();
  _resetConfig();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pure-function unit tests — no SAM instance needed
// ---------------------------------------------------------------------------

describe('_normalizeDimension — health', () => {
  it('maps overall_status, ssh_connected, process fields', () => {
    const raw = {
      overall_status: 'healthy',
      ssh_connected:  true,
      http_health:    { status_code: 200, reachable: true },
      http_ready:     { status_code: 200, reachable: true },
      process:        { running: true, uptime_seconds: 3600, restarts: 0 },
      checked_at:     '2025-01-01T00:00:00.000Z',
    };
    const result = asm._normalizeDimension('health', raw, null);
    expect(result.overall_status).toBe('healthy');
    expect(result.ssh_connected).toBe(true);
    expect(result.process.uptime_seconds).toBe(3600);
    expect(result.checked_at).toBe('2025-01-01T00:00:00.000Z');
    expect(result.error).toBeNull();
  });

  it('coerces errors array into a single string', () => {
    const raw = { errors: ['SSH timeout', 'HTTP 503'], checked_at: '2025-01-01T00:00:00.000Z' };
    const result = asm._normalizeDimension('health', raw, null);
    expect(result.error).toBe('SSH timeout; HTTP 503');
  });

  it('handles missing optional fields without throwing', () => {
    const result = asm._normalizeDimension('health', { checked_at: '2025-01-01T00:00:00.000Z' }, null);
    expect(result.overall_status).toBeNull();
    expect(result.http_health).toBeNull();
    expect(result.process).toBeNull();
  });
});

describe('_normalizeDimension — resources', () => {
  it('sets has_violations true when findings are present', () => {
    const raw = { findings: [{ dim: 'cpu', value: 99 }], sampled_processes: 42, checked_at: '2025-01-01T00:00:00.000Z' };
    const result = asm._normalizeDimension('resources', raw, null);
    expect(result.has_violations).toBe(true);
    expect(result.findings_count).toBe(1);
  });

  it('sets has_violations false for empty findings', () => {
    const raw = { findings: [], sampled_processes: 10, checked_at: '2025-01-01T00:00:00.000Z' };
    const result = asm._normalizeDimension('resources', raw, null);
    expect(result.has_violations).toBe(false);
    expect(result.findings_count).toBe(0);
  });

  it('handles skipped flag', () => {
    const result = asm._normalizeDimension('resources', { skipped: true }, null);
    expect(result.skipped).toBe(true);
    expect(result.has_violations).toBeUndefined();
  });
});

describe('_normalizeDimension — application', () => {
  it('maps all application fields', () => {
    const raw = {
      active_orders: 3, db_size_bytes: 2097152,
      online_ordering_paused: false, bun_version: '1.2.0',
      checked_at: '2025-01-01T00:00:00.000Z',
    };
    const result = asm._normalizeDimension('application', raw, null);
    expect(result.active_orders).toBe(3);
    expect(result.db_size_bytes).toBe(2097152);
    expect(result.online_ordering_paused).toBe(false);
    expect(result.bun_version).toBe('1.2.0');
  });
});

describe('_normalizeDimension — network', () => {
  it('accepts camelCase keys from internet_ip_check tool output', () => {
    const raw = { internetUp: true, publicIp: '1.2.3.4', checkedAt: '2025-01-01T00:00:00.000Z' };
    const result = asm._normalizeDimension('network', raw, null);
    expect(result.internet_up).toBe(true);
    expect(result.internet_ip).toBe('1.2.3.4');
    expect(result.checked_at).toBe('2025-01-01T00:00:00.000Z');
  });

  it('accepts snake_case keys as fallback', () => {
    const raw = { internet_up: true, internet_ip: '5.6.7.8', checked_at: '2025-01-01T00:00:00.000Z' };
    const result = asm._normalizeDimension('network', raw, null);
    expect(result.internet_up).toBe(true);
    expect(result.internet_ip).toBe('5.6.7.8');
  });
});

describe('_normalizeDimension — security (incremental merge)', () => {
  it('stores last_compliance_pass when compliance passes', () => {
    const now = '2025-01-01T00:00:00.000Z';
    const raw = { source: 'compliance_verify', passed: true, checked_at: now };
    const result = asm._normalizeDimension('security', raw, null);
    expect(result.last_compliance_pass).toBe(now);
    expect(result.credential_audit_ok).toBeNull();
    expect(result.git_audit_ok).toBeNull();
  });

  it('sets last_compliance_pass to false (not null) when compliance fails', () => {
    const raw = { source: 'compliance_verify', passed: false, checked_at: '2025-01-01T00:00:00.000Z' };
    const result = asm._normalizeDimension('security', raw, null);
    expect(result.last_compliance_pass).toBe(false);
  });

  it('merges credential_audit without overwriting existing compliance data', () => {
    const existing = {
      last_compliance_pass: '2025-01-01T00:00:00.000Z',
      credential_audit_ok:  null,
      git_audit_ok:         null,
      checked_at:           '2025-01-01T00:00:00.000Z',
      error:                null,
    };
    const raw = { source: 'credential_audit', ok: true, checked_at: '2025-01-01T01:00:00.000Z' };
    const result = asm._normalizeDimension('security', raw, existing);
    expect(result.last_compliance_pass).toBe('2025-01-01T00:00:00.000Z'); // preserved
    expect(result.credential_audit_ok).toBe(true);                        // updated
  });

  it('merges git_audit independently', () => {
    const existing = {
      last_compliance_pass: '2025-01-01T00:00:00.000Z',
      credential_audit_ok:  true,
      git_audit_ok:         null,
      checked_at:           '2025-01-01T01:00:00.000Z',
      error:                null,
    };
    const raw = { source: 'git_audit', ok: false, checked_at: '2025-01-01T02:00:00.000Z' };
    const result = asm._normalizeDimension('security', raw, existing);
    expect(result.credential_audit_ok).toBe(true); // preserved
    expect(result.git_audit_ok).toBe(false);        // updated
  });
});

describe('_buildSummary — pure builder', () => {
  const baseModel = {
    applianceName:    'Test POS',
    health:           null,
    resources:        null,
    application:      null,
    network:          null,
    security:         null,
    _updatedAt:       null,
    _staleDimensions: [],
  };

  it('outputs no-data lines when all dimensions are null', () => {
    const summary = asm._buildSummary(baseModel);
    expect(summary).toMatch(/health:.*no data/);
    expect(summary).toMatch(/resources:.*no data/);
    expect(summary).toMatch(/application:.*no data/);
    expect(summary).toMatch(/network:.*no data/);
    expect(summary).toMatch(/security:.*no data/);
  });

  it('outputs "Stale dimensions: (none)" when nothing is stale', () => {
    const summary = asm._buildSummary(baseModel);
    expect(summary).toContain('Stale dimensions: (none)');
  });

  it('names stale dimensions in the footer', () => {
    const model = { ...baseModel, _staleDimensions: ['health', 'network'] };
    const summary = asm._buildSummary(model);
    expect(summary).toContain('Stale dimensions: health, network');
  });

  it('marks a stale dimension with STALE label and threshold', () => {
    const recentIso = new Date(Date.now() - 25 * 60 * 1000).toISOString(); // 25 min ago — stale for health (10 min)
    const model = {
      ...baseModel,
      health: { overall_status: 'healthy', checked_at: recentIso },
      _staleDimensions: ['health'],
    };
    const summary = asm._buildSummary(model);
    expect(summary).toMatch(/health:.*STALE/);
    expect(summary).toMatch(/threshold 10 min/);
    expect(summary).toMatch(/Last known: healthy/);
  });

  it('renders healthy appliance details when all dimensions are fresh', () => {
    const now = new Date().toISOString();
    const model = {
      ...baseModel,
      health: {
        overall_status: 'healthy', ssh_connected: true,
        http_health: { status_code: 200 }, http_ready: { status_code: 200 },
        process: { running: true, uptime_seconds: 7200, restarts: 0 },
        checked_at: now,
      },
      resources:    { has_violations: false, findings_count: 0, sampled_processes: 15, checked_at: now },
      application:  { active_orders: 2, db_size_bytes: 1048576, online_ordering_paused: false, checked_at: now },
      network:      { internet_up: true, internet_ip: '1.2.3.4', checked_at: now },
      security:     {
        last_compliance_pass: now, credential_audit_ok: true, git_audit_ok: true,
        checked_at: now,
      },
      _staleDimensions: [],
    };
    const summary = asm._buildSummary(model);
    expect(summary).toContain('healthy');
    expect(summary).toContain('2 active orders');
    expect(summary).toContain('internet up, IP 1.2.3.4');
    expect(summary).toContain('compliance OK');
    expect(summary).toContain('Stale dimensions: (none)');
  });
});

// ---------------------------------------------------------------------------
// Integration tests — require full init() / close() lifecycle
// ---------------------------------------------------------------------------

describe('init() — no saved state', () => {
  it('initializes with all-null dimensions', () => {
    asm.init();
    const snap = asm.getSnapshot();
    expect(snap).toBeNull(); // no data until first probe fires
  });

  it('isFresh() returns false for all dimensions before any probe', () => {
    asm.init();
    for (const dim of asm.DIMENSIONS) {
      expect(asm.isFresh(dim)).toBe(false);
    }
  });

  it('getSummary() returns null before any probe', () => {
    asm.init();
    expect(asm.getSummary()).toBeNull();
  });

  it('creates ASM tables in the database', () => {
    asm.init();
    const db = getDb();
    const tableNames = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('appliance_state','appliance_state_history')`
    ).all().map(r => r.name).sort();
    expect(tableNames).toEqual(['appliance_state', 'appliance_state_history']);
  });
});

describe('init() — warm from saved snapshot', () => {
  it('populates getSnapshot() immediately from SQLite without waiting for a probe', () => {
    // Manually seed the appliance_state table.
    asm.init(); // run migrations
    const now = new Date().toISOString();
    const db  = getDb();
    db.prepare(`
      INSERT OR REPLACE INTO appliance_state
        (appliance_name, health, resources, application, network, security, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'Test POS',
      JSON.stringify({ overall_status: 'healthy', ssh_connected: true,
                       http_health: null, http_ready: null, process: null,
                       checked_at: now, error: null }),
      null, null, null, null, now,
    );

    // Re-init to exercise the warm-from-saved path.
    asm.close();
    asm.init();

    const snap = asm.getSnapshot();
    expect(snap).not.toBeNull();
    expect(snap.health.overall_status).toBe('healthy');
  });

  it('populates updated_at in the snapshot (not undefined) after warm restart', () => {
    asm.init();
    const now = new Date().toISOString();
    const db  = getDb();
    db.prepare(`
      INSERT OR REPLACE INTO appliance_state
        (appliance_name, health, resources, application, network, security, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('Test POS',
      JSON.stringify({ overall_status: 'healthy', ssh_connected: true, checked_at: now }),
      null, null, null, null, now);

    asm.close();
    asm.init();

    const snap = asm.getSnapshot();
    expect(snap.updated_at).toBeDefined();
    expect(snap.updated_at).not.toBeUndefined();
    expect(snap.updated_at).toBe(now);

    const summary = asm.getSummary();
    expect(summary).not.toContain('as of undefined');
  });

  it('marks recently-checked dimensions as fresh', () => {
    asm.init();
    const now = new Date().toISOString();
    const db  = getDb();
    db.prepare(`
      INSERT OR REPLACE INTO appliance_state
        (appliance_name, health, resources, application, network, security, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'Test POS',
      JSON.stringify({ checked_at: now, overall_status: 'healthy', ssh_connected: true }),
      null, null, null, null, now,
    );

    asm.close();
    asm.init();

    expect(asm.isFresh('health')).toBe(true);
    expect(asm.isFresh('resources')).toBe(false); // null → stale
  });
});

describe('applyProbe() — health', () => {
  beforeEach(() => asm.init());

  it('updates getSnapshot() after probe', async () => {
    const now = new Date().toISOString();
    asm.applyProbe('health', {
      overall_status: 'healthy', ssh_connected: true,
      http_health: { status_code: 200, reachable: true },
      http_ready:  { status_code: 200, reachable: true },
      process: { running: true, uptime_seconds: 1800, restarts: 0 },
      checked_at: now,
    });

    await tick();

    const snap = asm.getSnapshot();
    expect(snap).not.toBeNull();
    expect(snap.health.overall_status).toBe('healthy');
    expect(snap.health.ssh_connected).toBe(true);
    expect(snap.health.process.uptime_seconds).toBe(1800);
  });

  it('persists the snapshot to SQLite', async () => {
    const now = new Date().toISOString();
    asm.applyProbe('health', { overall_status: 'degraded', ssh_connected: false, checked_at: now });

    await tick();

    const db  = getDb();
    const row = db.prepare(
      `SELECT health FROM appliance_state WHERE appliance_name = 'Test POS'`
    ).get();
    expect(row).toBeDefined();
    const health = JSON.parse(row.health);
    expect(health.overall_status).toBe('degraded');
  });

  it('appends a history entry to appliance_state_history', async () => {
    const now = new Date().toISOString();
    asm.applyProbe('health', { overall_status: 'healthy', ssh_connected: true, checked_at: now });

    await tick();

    const db   = getDb();
    const rows = db.prepare(
      `SELECT dimension, data FROM appliance_state_history WHERE appliance_name = 'Test POS'`
    ).all();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].dimension).toBe('health');
    const data = JSON.parse(rows[0].data);
    expect(data.overall_status).toBe('healthy');
  });

  it('marks health as fresh after probe', async () => {
    const now = new Date().toISOString();
    asm.applyProbe('health', { overall_status: 'healthy', ssh_connected: true, checked_at: now });

    await tick();

    expect(asm.isFresh('health')).toBe(true);
    expect(asm.isFresh('resources')).toBe(false);
  });
});

describe('applyProbe() — security incremental merge', () => {
  beforeEach(() => asm.init());

  it('preserves credential_audit_ok when applying a compliance probe', async () => {
    const t1 = new Date().toISOString();
    asm.applyProbe('security', { source: 'credential_audit', ok: true, checked_at: t1 });
    await tick();

    const t2 = new Date().toISOString();
    asm.applyProbe('security', { source: 'compliance_verify', passed: true, checked_at: t2 });
    await tick();

    const snap = asm.getSnapshot();
    expect(snap.security.credential_audit_ok).toBe(true); // preserved from first probe
    expect(snap.security.last_compliance_pass).toBe(t2);  // set by second probe
  });

  it('accumulates all three security sources independently', async () => {
    const t = new Date().toISOString();
    asm.applyProbe('security', { source: 'compliance_verify',  passed: true,  checked_at: t });
    await tick();
    asm.applyProbe('security', { source: 'credential_audit',   ok: true,       checked_at: t });
    await tick();
    asm.applyProbe('security', { source: 'git_audit',          ok: false,      checked_at: t });
    await tick();

    const snap = asm.getSnapshot();
    expect(snap.security.last_compliance_pass).toBe(t);
    expect(snap.security.credential_audit_ok).toBe(true);
    expect(snap.security.git_audit_ok).toBe(false);
  });
});

describe('getSummary() — integration', () => {
  beforeEach(() => asm.init());

  it('includes "Stale dimensions: (none)" when all probed dimensions are fresh', async () => {
    const now = new Date().toISOString();
    asm.applyProbe('health',      { overall_status: 'healthy', ssh_connected: true, checked_at: now });
    await tick();
    asm.applyProbe('resources',   { findings: [], sampled_processes: 10, checked_at: now });
    await tick();
    asm.applyProbe('application', { active_orders: 1, db_size_bytes: 512000, online_ordering_paused: false, bun_version: '1.2.0', checked_at: now });
    await tick();
    asm.applyProbe('network',     { internetUp: true, publicIp: '1.2.3.4', checkedAt: now });
    await tick();
    asm.applyProbe('security',    { source: 'compliance_verify', passed: true, checked_at: now });
    await tick();

    // After every probe the staleness acceptor recomputes from scratch.
    // All five checked_at timestamps are 'now', well within every threshold.
    const summary = asm.getSummary();
    expect(summary).toContain('healthy');
    expect(summary).toContain('Stale dimensions: (none)');
  });

  it('shows "compliance FAIL" in summary when compliance probe reports failure', async () => {
    const now = new Date().toISOString();
    asm.applyProbe('security', { source: 'compliance_verify', passed: false, checked_at: now });
    await tick();
    const summary = asm.getSummary();
    expect(summary).toContain('compliance FAIL');
  });

  it('returns null before the first probe', () => {
    expect(asm.getSummary()).toBeNull();
  });
});

describe('getHistory()', () => {
  beforeEach(() => asm.init());

  it('returns history entries ordered newest-first', async () => {
    const t1 = '2025-01-01T00:00:00.000Z';
    const t2 = '2025-01-01T01:00:00.000Z';

    asm.applyProbe('network', { internetUp: true,  publicIp: '1.1.1.1', checkedAt: t1 });
    await tick();
    asm.applyProbe('network', { internetUp: false, publicIp: null,      checkedAt: t2 });
    await tick();

    const history = asm.getHistory('network');
    expect(history.length).toBeGreaterThanOrEqual(2);
    // Newest (t2) should be first.
    expect(history[0].data.internet_up).toBe(false);
    expect(history[1].data.internet_up).toBe(true);
  });

  it('respects the limit parameter', async () => {
    const now = new Date().toISOString();
    for (let i = 0; i < 5; i++) {
      asm.applyProbe('health', { overall_status: 'healthy', ssh_connected: true, checked_at: now });
      await tick(20);
    }

    const history = asm.getHistory('health', 3);
    expect(history.length).toBeLessThanOrEqual(3);
  });

  it('returns entries only for the requested dimension', async () => {
    const now = new Date().toISOString();
    asm.applyProbe('health',   { overall_status: 'healthy', ssh_connected: true, checked_at: now });
    await tick();
    asm.applyProbe('network',  { internetUp: true, publicIp: '1.2.3.4', checkedAt: now });
    await tick();

    const healthHistory  = asm.getHistory('health');
    const networkHistory = asm.getHistory('network');
    expect(healthHistory.every(r => r.data.overall_status !== undefined)).toBe(true);
    expect(networkHistory.every(r => r.data.internet_up   !== undefined)).toBe(true);
  });

  it('returns [] when no history exists for a dimension', () => {
    expect(asm.getHistory('application')).toEqual([]);
  });
});

describe('pruneOldHistory()', () => {
  beforeEach(() => asm.init());

  it('removes history rows older than 7 days', async () => {
    // Insert a stale row directly.
    const db  = getDb();
    const old = '2020-01-01T00:00:00.000Z'; // definitely > 7 days ago
    db.prepare(`
      INSERT INTO appliance_state_history (appliance_name, dimension, data, recorded_at)
      VALUES (?, ?, ?, ?)
    `).run('Test POS', 'health', JSON.stringify({ overall_status: 'healthy' }), old);

    // Also insert a fresh row via probe.
    const now = new Date().toISOString();
    asm.applyProbe('health', { overall_status: 'healthy', ssh_connected: true, checked_at: now });
    await tick();

    // Row count before.
    const before = db.prepare(
      `SELECT COUNT(*) AS n FROM appliance_state_history WHERE appliance_name = 'Test POS'`
    ).get().n;
    expect(before).toBeGreaterThanOrEqual(2);

    asm.pruneOldHistory();

    const after = db.prepare(
      `SELECT COUNT(*) AS n FROM appliance_state_history WHERE appliance_name = 'Test POS'`
    ).get().n;
    expect(after).toBeLessThan(before);

    const rows = db.prepare(
      `SELECT recorded_at FROM appliance_state_history WHERE appliance_name = 'Test POS'`
    ).all();
    expect(rows.every(r => r.recorded_at > old)).toBe(true);
  });

  it('does not throw when called before any history exists', () => {
    expect(() => asm.pruneOldHistory()).not.toThrow();
  });
});

describe('close() — teardown', () => {
  it('clears cached snapshot and summary', () => {
    asm.init();
    asm.close();
    expect(asm.getSnapshot()).toBeNull();
    expect(asm.getSummary()).toBeNull();
  });

  it('isFresh() returns false after close', () => {
    asm.init();
    asm.close();
    for (const dim of asm.DIMENSIONS) {
      expect(asm.isFresh(dim)).toBe(false);
    }
  });

  it('applyProbe() after close does not throw (logs warning, no-ops)', () => {
    asm.init();
    asm.close();
    expect(() => asm.applyProbe('health', { overall_status: 'healthy' })).not.toThrow();
  });
});

describe('applyProbe() — unknown dimension', () => {
  beforeEach(() => asm.init());

  it('does not throw synchronously; error is caught internally', () => {
    expect(() => asm.applyProbe('bogus', {})).not.toThrow();
  });
});

describe('DIMENSIONS and STALENESS_MS exports', () => {
  it('exports all five dimension names', () => {
    expect(asm.DIMENSIONS).toEqual(['health', 'resources', 'application', 'network', 'security']);
  });

  it('staleness thresholds have correct ordering (health < application < network < security)', () => {
    const { STALENESS_MS } = asm;
    expect(STALENESS_MS.health).toBeLessThan(STALENESS_MS.application);
    expect(STALENESS_MS.application).toBeLessThan(STALENESS_MS.network);
    expect(STALENESS_MS.network).toBeLessThan(STALENESS_MS.security);
  });
});
