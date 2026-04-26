'use strict';

/**
 * T-2.2 — Shift Report Email Delivery
 *
 * Cron fires shift_report → COSA generates report → email sent with correct
 * subject "[COSA] Shift Report: YYYY-MM-DD".
 * Deduplication: second call within 6 hours produces no second email.
 */

// ---------------------------------------------------------------------------
// Boundary mocks
// ---------------------------------------------------------------------------

const mockMessagesCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () =>
  jest.fn(() => ({ messages: { create: (...a) => mockMessagesCreate(...a) } }))
);

let mockStagingConfig;
jest.mock('../../config/cosa.config', () => ({
  getConfig:    () => mockStagingConfig,
  _resetConfig: () => {},
}));

jest.mock('../../src/ssh-backend', () => ({
  isConnected: jest.fn().mockReturnValue(true),
  exec:        jest.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
  init:        jest.fn().mockResolvedValue(undefined),
  disconnect:  jest.fn(),
}));

jest.mock('imapflow', () => ({
  ImapFlow: jest.fn().mockImplementation(() => ({
    connect:         jest.fn().mockResolvedValue(undefined),
    getMailboxLock:  jest.fn().mockResolvedValue({ release: jest.fn() }),
    search:          jest.fn().mockResolvedValue([]),
    fetchOne:        jest.fn(),
    messageFlagsAdd: jest.fn().mockResolvedValue(undefined),
    logout:          jest.fn().mockResolvedValue(undefined),
  })),
}));

const mockSentEmails = [];
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({
    sendMail: jest.fn((opts) => {
      mockSentEmails.push({ ...opts });
      return Promise.resolve({ messageId: '<sent@test>' });
    }),
  })),
}));

jest.mock('../../src/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const {
  makeStagingConfig, makeTempDataDir,
  claudeToolUse, claudeEndTurn,
} = require('./harness');

const sshBackendMock = require('../../src/ssh-backend');

const SHIFT_REPORT_BODY = `Daily Shift Report
==================
Health checks: 24 runs, all healthy.
Backups: 1 successful.
No anomalies detected.

— COSA`;

let cronScheduler;
let sessionStore;
let toolRegistry;

beforeAll(() => {
  process.env.NODE_ENV = 'staging';
  mockStagingConfig    = makeStagingConfig(makeTempDataDir());

  sessionStore = require('../../src/session-store');
  sessionStore.runMigrations();

  const skillStore = require('../../src/skill-store');
  skillStore.runMigrations();

  toolRegistry = require('../../src/tool-registry');
  const sr = require('../../src/tools/shift-report');
  toolRegistry.register(sr.name, sr.schema, sr.handler, sr.riskLevel);

  cronScheduler = require('../../src/cron-scheduler');
});

afterAll(() => {
  cronScheduler.stop();
  sessionStore.closeDb();
  toolRegistry._reset();
  delete process.env.NODE_ENV;
});

beforeEach(() => {
  mockSentEmails.length = 0;
  // Claude calls shift_report then writes the full report as its final response.
  mockMessagesCreate
    .mockResolvedValueOnce(claudeToolUse('shift_report'))
    .mockResolvedValueOnce(claudeEndTurn(SHIFT_REPORT_BODY));
});

afterEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// T-2.2 assertions
// ---------------------------------------------------------------------------

describe('T-2.2 — Shift report email delivery', () => {
  it('sends one email to the operator', async () => {
    await cronScheduler.runShiftReportTask();
    expect(mockSentEmails).toHaveLength(1);
    expect(mockSentEmails[0].to).toBe('operator@test.local');
  });

  it('email subject matches [COSA] Shift Report: YYYY-MM-DD', async () => {
    await cronScheduler.runShiftReportTask();
    const today = new Date().toISOString().slice(0, 10);
    expect(mockSentEmails[0].subject).toBe(`[COSA] Shift Report: ${today}`);
  });

  it('email body is the rendered shift-report template (plain text)', async () => {
    await cronScheduler.runShiftReportTask();
    expect(mockSentEmails[0].text).toContain('COSA — Shift Report');
    expect(mockSentEmails[0].text).toContain('ORDERS');
    expect(mockSentEmails[0].text).toContain('REVENUE');
  });

  it('formatShiftReportBody renders all four order buckets and the new revenue rows', () => {
    const body = cronScheduler.formatShiftReportBody({
      period_start: '2026-04-25T13:00:00.000Z',
      period_end:   '2026-04-26T13:00:00.000Z',
      orders:       { total: 3, paid: 1, cancelled: 1, refunded: 1, active: 0 },
      revenue: {
        payment_count:        2,
        payments_total:       1826.67,
        service_charge_total: 3.40,
        total:                1830.07,
        avg_order_value:      1830.07,
        currency:             'USD',
      },
      payment_errors: 0,
      staff_count:    2,
      anomalies:      [],
    });

    expect(body).toMatch(/Total:\s+3/);
    expect(body).toMatch(/Paid:\s+1/);
    expect(body).toMatch(/Cancelled:\s+1/);
    expect(body).toMatch(/Refunded:\s+1/);
    expect(body).toMatch(/Active:\s+0/);
    expect(body).toMatch(/Payments:\s+2/);
    expect(body).toMatch(/Payments total:\s+\$1826\.67 USD/);
    expect(body).toMatch(/Service charge:\s+\$3\.40 USD/);
    expect(body).toMatch(/Grand total:\s+\$1830\.07 USD/);
  });

  it('shift_report tool returns the new revenue shape directly', async () => {
    sshBackendMock.exec.mockImplementation((_cmd, sql) => {
      if (sql.includes('FROM orders')) {
        return Promise.resolve({
          stdout: JSON.stringify([{
            total_orders: 27, paid: 27, cancelled: 0, refunded: 0, active: 0,
            service_charge_cents: 3340,
          }]),
          stderr: '', exitCode: 0,
        });
      }
      if (sql.includes('FROM payments')) {
        return Promise.resolve({
          stdout: JSON.stringify([{ payment_count: 28, amount_cents: 182667 }]),
          stderr: '', exitCode: 0,
        });
      }
      if (sql.includes('FROM payment_errors')) {
        return Promise.resolve({
          stdout: JSON.stringify([{ error_count: 0 }]), stderr: '', exitCode: 0,
        });
      }
      if (sql.includes('FROM timesheets')) {
        return Promise.resolve({
          stdout: JSON.stringify([{ staff_count: 0 }]), stderr: '', exitCode: 0,
        });
      }
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });

    const sr = require('../../src/tools/shift-report');
    const out = await sr.handler({ lookback_hours: 24 });

    expect(out.orders).toEqual({ total: 27, paid: 27, cancelled: 0, refunded: 0, active: 0 });
    expect(out.revenue.payment_count).toBe(28);
    expect(out.revenue.payments_total).toBe(1826.67);
    expect(out.revenue.service_charge_total).toBe(33.40);
    expect(out.revenue.total).toBe(1860.07);
  });

  it('orders SQL casts both sides through datetime() for format-safe comparison', async () => {
    let capturedOrdersSql = '';
    sshBackendMock.exec.mockImplementation((_cmd, sql) => {
      if (sql.includes('FROM orders')) capturedOrdersSql = sql;
      return Promise.resolve({ stdout: '[]', stderr: '', exitCode: 0 });
    });

    const sr = require('../../src/tools/shift-report');
    await sr.handler({ lookback_hours: 24 });

    expect(capturedOrdersSql).toMatch(/datetime\(created_at\)\s*>=\s*datetime\('/);
    expect(capturedOrdersSql).toMatch(/datetime\(created_at\)\s*<\s*datetime\('/);
    // Bound is space-format, NOT ISO with 'T...Z'.
    expect(capturedOrdersSql).toMatch(/datetime\('\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}'\)/);
    expect(capturedOrdersSql).not.toMatch(/T\d{2}:\d{2}:\d{2}\.\d+Z/);
  });

  it('creates an alert row with category=shift_report', async () => {
    await cronScheduler.runShiftReportTask();
    const row = sessionStore.getDb()
      .prepare("SELECT category, severity FROM alerts WHERE category='shift_report' ORDER BY id DESC LIMIT 1")
      .get();
    expect(row).toBeDefined();
    expect(row.severity).toBe('info');
  });

  it('does NOT send a second email when called again within dedup window', async () => {
    // First call sent an email (from previous test or this run).
    // Reset emails, run again — should be suppressed.
    mockSentEmails.length = 0;
    // Re-mock Claude for second call attempt.
    mockMessagesCreate
      .mockResolvedValueOnce(claudeToolUse('shift_report'))
      .mockResolvedValueOnce(claudeEndTurn(SHIFT_REPORT_BODY));

    await cronScheduler.runShiftReportTask();
    // An alert row already exists from previous test; dedup should suppress.
    expect(mockSentEmails).toHaveLength(0);
  });
});
