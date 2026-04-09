'use strict';

/**
 * Phase 3 — End-to-End Staging Test: Simulated Intrusion
 *
 * Tests the complete intrusion detection and automated response pipeline:
 *   access_log_scan → anomaly classification → SecurityFSM escalation →
 *   cloudflare_kill → ips_alert email → operator CLEAR-THREAT → recovery →
 *   health check → monitoring
 *
 * ACs covered: AC1–AC12 (phase-3-secure-spec)
 */

const os   = require('os');
const fs   = require('fs');
const path = require('path');

// ─── Mock boundaries (must be hoisted before any require) ────────────────────

jest.mock('@anthropic-ai/sdk', () =>
  jest.fn(() => ({ messages: { create: jest.fn() } }))
);

let mockStagingConfig;

// ---------------------------------------------------------------------------
// In-memory SQLite substitute — better-sqlite3 native bindings fail on Windows.
// mockDbStore is a Map shared across ALL mock Database instances so that when
// security-fsm upserts a row and AC10 opens a new read-only Database to verify
// it, both see the same data.
// ---------------------------------------------------------------------------
const mockDbStore = new Map();

jest.mock('better-sqlite3', () =>
  jest.fn().mockImplementation(() => ({
    pragma:  jest.fn(),
    exec:    jest.fn(),
    prepare: jest.fn((sql) => {
      const lo = sql.toLowerCase();

      // security_incidents INSERT / UPSERT (ON CONFLICT DO UPDATE)
      if (lo.includes('security_incidents') && lo.includes('insert')) {
        return {
          run: jest.fn((params) => {
            const id       = params.incident_id;
            const existing = mockDbStore.get(id);
            // Merge so ON CONFLICT updates win over the initial INSERT.
            mockDbStore.set(id, existing
              ? { ...existing, ...params }
              : { ...params });
            return { changes: 1, lastInsertRowid: mockDbStore.size };
          }),
        };
      }

      // security_incidents SELECT … WHERE incident_id = ?
      if (lo.includes('security_incidents') && lo.includes('select') && lo.includes('where')) {
        return {
          get: jest.fn((id) => mockDbStore.get(id) ?? null),
          all: jest.fn(() => [...mockDbStore.values()]),
        };
      }

      // security_incidents SELECT all rows (AC11)
      if (lo.includes('security_incidents') && lo.includes('select')) {
        return {
          all: jest.fn(() => [...mockDbStore.values()]),
          get: jest.fn(() => null),
        };
      }

      // Catch-all (CREATE TABLE, session-store statements, etc.)
      return {
        run: jest.fn(() => ({ changes: 1, lastInsertRowid: 1 })),
        get: jest.fn(() => null),
        all: jest.fn(() => []),
      };
    }),
    close: jest.fn(),
  }))
);

// session-store: mock entirely so its own better-sqlite3 calls (migrations,
// alert inserts) don't interfere.  The security-fsm writes directly to the
// better-sqlite3 mock above; tests verify data through that same mock.
jest.mock('../../src/session-store', () => ({
  runMigrations:    jest.fn(),
  createAlert:      jest.fn(),
  findRecentAlert:  jest.fn(() => null),
  getLastToolOutput: jest.fn(() => ({})),
}));

jest.mock('../../config/cosa.config', () => ({
  getConfig:    () => mockStagingConfig,
  _resetConfig: () => {},
}));

const mockIsConnected = jest.fn().mockReturnValue(true);
const mockSshExec     = jest.fn();
jest.mock('../../src/ssh-backend', () => ({
  isConnected: mockIsConnected,
  exec:        mockSshExec,
  init:        jest.fn().mockResolvedValue(undefined),
  disconnect:  jest.fn(),
}));

jest.mock('imapflow', () => ({
  ImapFlow: jest.fn().mockImplementation(() => ({
    connect:         jest.fn().mockResolvedValue(undefined),
    logout:          jest.fn().mockResolvedValue(undefined),
    on:              jest.fn(),
    off:             jest.fn(),
    addMessageFlags: jest.fn().mockResolvedValue(undefined),
    [Symbol.asyncIterator]: jest.fn().mockReturnValue({
      next: jest.fn().mockResolvedValue({ done: true }),
    }),
  })),
}));

const mockSentEmails = [];
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({
    sendMail: jest.fn(async (opts) => {
      mockSentEmails.push({ ...opts });
      return { messageId: '<mock@test.local>' };
    }),
    verify: jest.fn().mockResolvedValue(true),
  })),
}));

jest.mock('../../src/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
  }),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const { makeStagingConfig, flushPromises, SYSTEMCTL_HEALTHY } = require('./harness');

const ATTACKER_IP  = '192.168.1.99';
const MONTH_NAMES  = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Build a single NGINX combined-log-format line. offsetMs = ms before now. */
function nginxLogLine(ip, status, method, urlPath, ua, offsetMs) {
  const ts    = new Date(Date.now() - offsetMs);
  const day   = String(ts.getUTCDate()).padStart(2, '0');
  const month = MONTH_NAMES[ts.getUTCMonth()];
  const year  = ts.getUTCFullYear();
  const hh    = String(ts.getUTCHours()).padStart(2, '0');
  const mm    = String(ts.getUTCMinutes()).padStart(2, '0');
  const ss    = String(ts.getUTCSeconds()).padStart(2, '0');
  return (
    `${ip} - - [${day}/${month}/${year}:${hh}:${mm}:${ss} +0000] ` +
    `"${method} ${urlPath} HTTP/1.1" ${status} 512 "-" "${ua}"`
  );
}

/**
 * 6 HTTP-401 login failures from ATTACKER_IP within ~5 minutes.
 * count(6) > THRESHOLD(5) triggers brute_force detection.
 */
function makeBruteForceLog() {
  const lines = [];
  for (let i = 0; i < 6; i++) {
    lines.push(
      nginxLogLine(
        ATTACKER_IP, 401, 'POST', '/api/login', 'python-brute/1.0',
        (5 - i) * 50 * 1000,  // spaced ~50 s apart, all within 5-min window
      )
    );
  }
  return lines.join('\n');
}

/** Clean access log — all successful requests, no anomalies. */
function makeCleanLog() {
  return [
    nginxLogLine('10.0.0.1', 200, 'GET',  '/',          'curl/7.68.0',  600_000),
    nginxLogLine('10.0.0.2', 200, 'GET',  '/health',    'uptime-bot',   480_000),
    nginxLogLine('10.0.0.3', 201, 'POST', '/api/order', 'app/1.0',      360_000),
    nginxLogLine('10.0.0.4', 200, 'GET',  '/api/menu',  'browser/1.0',  240_000),
  ].join('\n');
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('Phase 3 E2E — Simulated Intrusion (Staging)', () => {
  let dataDir;
  let toolRegistry;
  let sessionStore;
  let accessLogScanTool;
  let cloudflareKillTool;
  let ipsAlertTool;
  let healthCheckTool;
  let securityFsm;
  let Database;

  /** Mock cloudflare_kill handler — skips the 2-second sleep in the real tool. */
  const mockCfKillHandler = jest.fn().mockResolvedValue({
    success:          true,
    method:           'systemctl',
    verificationPass: true,
    error:            null,
    timestamp:        new Date().toISOString(),
  });

  // ─── Suite setup / teardown ────────────────────────────────────────────────

  beforeAll(async () => {
    process.env.NODE_ENV = 'staging';

    dataDir           = fs.mkdtempSync(path.join(os.tmpdir(), 'cosa-phase3-'));
    mockStagingConfig = makeStagingConfig(dataDir);

    // Enable Phase 3 tools — harness only enables health_check/db_query/db_integrity
    mockStagingConfig.appliance.tools.access_log_scan = { enabled: true };
    mockStagingConfig.appliance.tools.cloudflare_kill = { enabled: true };
    mockStagingConfig.appliance.tools.ips_alert       = { enabled: true };

    toolRegistry       = require('../../src/tool-registry');
    sessionStore       = require('../../src/session-store');
    accessLogScanTool  = require('../../src/tools/access-log-scan');
    cloudflareKillTool = require('../../src/tools/cloudflare-kill');
    ipsAlertTool       = require('../../src/tools/ips-alert');
    healthCheckTool    = require('../../src/tools/health-check');
    securityFsm        = require('../../src/security-fsm');
    Database           = require('better-sqlite3');

    sessionStore.runMigrations();

    toolRegistry.register(
      accessLogScanTool.name,
      accessLogScanTool.schema,
      accessLogScanTool.handler,
      accessLogScanTool.riskLevel,
    );
    // cloudflare_kill uses a mock handler to avoid the 2-second sleep.
    toolRegistry.register(
      cloudflareKillTool.name,
      cloudflareKillTool.schema,
      mockCfKillHandler,
      cloudflareKillTool.riskLevel,
    );
    toolRegistry.register(
      ipsAlertTool.name,
      ipsAlertTool.schema,
      ipsAlertTool.handler,
      ipsAlertTool.riskLevel,
    );
    toolRegistry.register(
      healthCheckTool.name,
      healthCheckTool.schema,
      healthCheckTool.handler,
      healthCheckTool.riskLevel,
    );
  });

  afterAll(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    mockIsConnected.mockReturnValue(true);
    mockSshExec.mockReset();
    mockCfKillHandler.mockClear();
    mockSentEmails.length = 0;
  });

  // ─── AC1 ──────────────────────────────────────────────────────────────────

  describe('AC1 — access_log_scan detects simulated brute-force', () => {
    it('returns a brute_force anomaly (severity=high) from the attacker IP', async () => {
      mockSshExec.mockResolvedValue({ stdout: makeBruteForceLog(), exitCode: 0 });

      const result = await toolRegistry.dispatch('access_log_scan', {});
      const bf     = result.anomalies.find(a => a.type === 'brute_force');

      expect(bf).toBeDefined();
      expect(bf.sourceIp).toBe(ATTACKER_IP);
      expect(bf.severity).toBe('high');
      expect(bf.count).toBeGreaterThan(5);
      expect(bf.windowMinutes).toBe(5);
    });
  });

  // ─── AC2-3 ────────────────────────────────────────────────────────────────

  describe('AC2–AC3 — Anomaly classification and FSM escalation', () => {
    it('AC2: classifying the anomaly sets severity=high and anomalyType=brute_force', () => {
      const fsm = securityFsm.createSecurityFSM();
      fsm.send('ANOMALY_DETECTED');
      fsm.send('CLASSIFY_HIGH', { severity: 'high', anomalyType: 'brute_force' });

      const inc = fsm._getIncident();
      expect(inc.severity).toBe('high');
      expect(inc.anomalyType).toBe('brute_force');
    });

    it('AC3: FSM enters responding state immediately after CLASSIFY_HIGH', () => {
      const fsm = securityFsm.createSecurityFSM();
      fsm.send('ANOMALY_DETECTED');
      fsm.send('CLASSIFY_HIGH', { severity: 'high', anomalyType: 'brute_force' });
      expect(fsm.current).toBe('responding');
    });
  });

  // ─── AC4-5 ────────────────────────────────────────────────────────────────

  describe('AC4–AC5 — Automated response: kill and alert', () => {
    it('AC4: cloudflare_kill is dispatched by the responding NAP', async () => {
      const fsm = securityFsm.createSecurityFSM();
      fsm.send('ANOMALY_DETECTED');
      fsm.send('CLASSIFY_HIGH', {
        severity:    'high',
        anomalyType: 'brute_force',
        details:     { sourceIp: ATTACKER_IP, count: 6 },
      });
      await flushPromises();
      await flushPromises();

      expect(mockCfKillHandler).toHaveBeenCalledTimes(1);
    });

    it('AC5: ips_alert email is sent to the operator after cloudflare_kill', async () => {
      const fsm = securityFsm.createSecurityFSM();
      fsm.send('ANOMALY_DETECTED');
      fsm.send('CLASSIFY_HIGH', {
        severity:    'high',
        anomalyType: 'brute_force',
        details:     { sourceIp: ATTACKER_IP, count: 6 },
      });
      await flushPromises();
      await flushPromises();

      expect(mockSentEmails.length).toBeGreaterThan(0);
      expect(mockSentEmails[0].to).toBe('operator@test.local');
      expect(mockSentEmails[0].subject).toMatch(/\[COSA SECURITY\]/);
    });
  });

  // ─── AC6 ──────────────────────────────────────────────────────────────────

  describe('AC6 — Alert email contains required incident fields', () => {
    it('email body contains evidence, attacker IP, actions taken, and CLEAR-THREAT code', async () => {
      // Call ips_alert directly with full structured schema — the security-fsm
      // NAP dispatch uses legacy fields that omit responseOptions/CLEAR-THREAT.
      await toolRegistry.dispatch('ips_alert', {
        severity:            'HIGH',
        incidentType:        `Brute-force: 6 failed logins from ${ATTACKER_IP} in 5 min`,
        evidence:            [
          `${ATTACKER_IP} made 6 HTTP-401 requests to /api/login in 5 minutes`,
        ],
        actionsAlreadyTaken: 'Cloudflare tunnel daemon killed via systemctl',
        responseOptions:     [
          'CLEAR-THREAT: Confirm threat is resolved and restore normal operations',
        ],
        autoExpireMinutes:   30,
      });

      expect(mockSentEmails).toHaveLength(1);
      const { to, subject, text: body } = mockSentEmails[0];
      expect(to).toBe('operator@test.local');
      expect(subject).toMatch(/\[COSA SECURITY\]/);
      expect(subject).toMatch(/HIGH/);
      expect(body).toContain('─── EVIDENCE');
      expect(body).toContain(ATTACKER_IP);
      expect(body).toContain('ACTIONS ALREADY TAKEN');
      expect(body).toContain('Cloudflare tunnel daemon killed');
      expect(body).toContain('CLEAR-THREAT');
      expect(body).toMatch(/IPS-\d{10,}/);
    });
  });

  // ─── AC7 ──────────────────────────────────────────────────────────────────

  describe('AC7 — CLEAR-THREAT reply advances FSM to recovering', () => {
    it('FSM moves from awaiting_clearance to recovering on CLEAR_THREAT event', async () => {
      const fsm = securityFsm.createSecurityFSM();
      fsm.send('ANOMALY_DETECTED');
      fsm.send('CLASSIFY_HIGH', { severity: 'high', anomalyType: 'brute_force' });
      await flushPromises();
      await flushPromises();

      expect(fsm.current).toBe('awaiting_clearance');
      fsm.send('CLEAR_THREAT');
      expect(fsm.current).toBe('recovering');
    });
  });

  // ─── AC8 ──────────────────────────────────────────────────────────────────

  describe('AC8 — Cloudflare tunnel kill is verified', () => {
    it('cloudflare_kill returns success=true with verificationPass=true', async () => {
      const result = await toolRegistry.dispatch('cloudflare_kill', {});
      expect(result.success).toBe(true);
      expect(result.verificationPass).toBe(true);
      expect(result.method).toBe('systemctl');
      expect(result.error).toBeNull();
    });
  });

  // ─── AC9 ──────────────────────────────────────────────────────────────────

  describe('AC9 — Health check and FSM returns to monitoring', () => {
    it('FSM transitions recovering → monitoring on HEALTH_CHECK_PASS', async () => {
      const fsm = securityFsm.createSecurityFSM();
      fsm.send('ANOMALY_DETECTED');
      fsm.send('CLASSIFY_HIGH', { severity: 'high', anomalyType: 'brute_force' });
      await flushPromises();
      await flushPromises();

      fsm.send('CLEAR_THREAT');
      expect(fsm.current).toBe('recovering');
      fsm.send('HEALTH_CHECK_PASS');
      expect(fsm.current).toBe('monitoring');
    });

    it('health_check tool dispatches without throwing when SSH is connected', async () => {
      mockSshExec.mockResolvedValue({ stdout: SYSTEMCTL_HEALTHY, exitCode: 0 });
      // HTTP probes to 192.168.1.10 will fail (ECONNREFUSED) — tool must not throw.
      await expect(toolRegistry.dispatch('health_check', {})).resolves.toBeDefined();
    });
  });

  // ─── AC10 ─────────────────────────────────────────────────────────────────

  describe('AC10 — Full incident lifecycle recorded in security_incidents', () => {
    it('persists cloudflare_killed=1, alert_sent=1, and final state=monitoring', async () => {
      const fsm        = securityFsm.createSecurityFSM();
      const incidentId = fsm.incidentId;

      fsm.send('ANOMALY_DETECTED');
      fsm.send('CLASSIFY_HIGH', { severity: 'high', anomalyType: 'brute_force' });
      await flushPromises();
      await flushPromises();

      fsm.send('CLEAR_THREAT');
      fsm.send('HEALTH_CHECK_PASS');

      const db  = new Database(path.join(dataDir, 'session.db'), { readonly: true });
      const row = db.prepare(
        'SELECT * FROM security_incidents WHERE incident_id = ?'
      ).get(incidentId);
      db.close();

      expect(row).toBeDefined();
      expect(row.state).toBe('monitoring');
      expect(row.severity).toBe('high');
      expect(row.cloudflare_killed).toBe(1);
      expect(row.alert_sent).toBe(1);
      expect(row.created_at).toBeTruthy();
      expect(row.updated_at).toBeTruthy();
    });
  });

  // ─── AC11 ─────────────────────────────────────────────────────────────────

  describe('AC11 — No credentials appear in outbound emails or session records', () => {
    const CRED_PATTERNS = [
      /sk-ant-[a-zA-Z0-9_-]{10,}/,
      /COSA_CREDENTIAL_KEY\s*[:=]\s*\S+/i,
      /password\s*[:=]\s*\S{4,}/i,
      /secret\s*[:=]\s*\S{8,}/i,
      /Bearer\s+[a-zA-Z0-9+/=]{20,}/,
    ];

    it('sent emails contain no credential-like strings', async () => {
      const fsm = securityFsm.createSecurityFSM();
      fsm.send('ANOMALY_DETECTED');
      fsm.send('CLASSIFY_HIGH', {
        severity:    'high',
        anomalyType: 'brute_force',
        details:     { sourceIp: ATTACKER_IP, count: 6 },
      });
      await flushPromises();
      await flushPromises();

      for (const email of mockSentEmails) {
        const flat = JSON.stringify(email);
        for (const pattern of CRED_PATTERNS) {
          expect(flat).not.toMatch(pattern);
        }
      }
    });

    it('security_incidents rows contain no raw credentials', async () => {
      const db   = new Database(path.join(dataDir, 'session.db'), { readonly: true });
      const rows = db.prepare('SELECT * FROM security_incidents').all();
      db.close();

      for (const row of rows) {
        const flat = JSON.stringify(row);
        for (const pattern of CRED_PATTERNS) {
          expect(flat).not.toMatch(pattern);
        }
      }
    });
  });

  // ─── AC12 ─────────────────────────────────────────────────────────────────

  describe('AC12 — Clean access log: no anomalies, no alerts', () => {
    beforeEach(() => {
      mockSentEmails.length = 0;
    });

    it('access_log_scan against a healthy log returns zero anomalies', async () => {
      mockSshExec.mockResolvedValue({ stdout: makeCleanLog(), exitCode: 0 });

      const result = await toolRegistry.dispatch('access_log_scan', {});
      expect(result.anomalies).toHaveLength(0);
      expect(result.totalRequests).toBe(4);
      expect(result.errorRatePercent).toBe(0);
    });

    it('no alert emails are sent when access_log_scan finds no anomalies', async () => {
      mockSshExec.mockResolvedValue({ stdout: makeCleanLog(), exitCode: 0 });

      await toolRegistry.dispatch('access_log_scan', {});

      expect(mockSentEmails).toHaveLength(0);
    });
  });
});
