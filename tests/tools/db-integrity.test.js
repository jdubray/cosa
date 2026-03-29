'use strict';

// ---------------------------------------------------------------------------
// Mocks — `mock` prefix exempts them from Jest's hoisting TDZ rule.
// ---------------------------------------------------------------------------

const mockExec      = jest.fn();
const mockGetConfig = jest.fn();

jest.mock('../../src/ssh-backend', () => ({
  exec: (...a) => mockExec(...a),
}));

jest.mock('../../config/cosa.config', () => ({
  getConfig: (...a) => mockGetConfig(...a),
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

const { handler } = require('../../src/tools/db-integrity');

// ---------------------------------------------------------------------------
// Config fixtures
// ---------------------------------------------------------------------------

const BASE_CONFIG = {
  appliance: {
    database: { path: '/home/baanbaan/app/data/baanbaan.db' },
    tools: {
      db_integrity: {
        enabled:            true,
        run_wal_checkpoint: true,
      },
    },
  },
};

const CONFIG_NO_WAL = {
  appliance: {
    database: { path: '/home/baanbaan/app/data/baanbaan.db' },
    tools: {
      db_integrity: {
        enabled:            true,
        run_wal_checkpoint: false,
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockGetConfig.mockReturnValue(BASE_CONFIG);
  // Default: integrity_check returns "ok", checkpoint returns "0|5|5"
  mockExec
    .mockResolvedValueOnce({ stdout: 'ok\n',    stderr: '', exitCode: 0 })
    .mockResolvedValueOnce({ stdout: '0|5|5\n', stderr: '', exitCode: 0 });
});

afterEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// AC1 — PRAGMA integrity_check command format
// ---------------------------------------------------------------------------

describe('AC1 — integrity_check command', () => {
  it('calls exec with the correct sqlite3 integrity_check command', async () => {
    await handler();
    expect(mockExec.mock.calls[0][0]).toBe(
      'sqlite3 /home/baanbaan/app/data/baanbaan.db "PRAGMA integrity_check"'
    );
  });

  it('uses the database path from appliance config', async () => {
    mockGetConfig.mockReturnValue({
      ...BASE_CONFIG,
      appliance: {
        ...BASE_CONFIG.appliance,
        database: { path: '/custom/db/baanbaan.db' },
      },
    });
    // Reset default exec mocks for this config change
    mockExec.mockReset();
    mockExec
      .mockResolvedValueOnce({ stdout: 'ok\n',    stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '0|5|5\n', stderr: '', exitCode: 0 });

    await handler();
    expect(mockExec.mock.calls[0][0]).toContain('/custom/db/baanbaan.db');
  });
});

// ---------------------------------------------------------------------------
// AC2 — is_healthy and integrity_result parsing
// ---------------------------------------------------------------------------

describe('AC2 — is_healthy and integrity_result', () => {
  it('sets is_healthy: true when integrity_check returns "ok"', async () => {
    const result = await handler();
    expect(result.is_healthy).toBe(true);
  });

  it('sets is_healthy: false when integrity_check returns error lines', async () => {
    mockExec.mockReset();
    mockExec
      .mockResolvedValueOnce({
        stdout:   'row 1 missing from index orders_idx\nwrong # of entries in index\n',
        stderr:   '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({ stdout: '0|5|5\n', stderr: '', exitCode: 0 });

    const result = await handler();
    expect(result.is_healthy).toBe(false);
  });

  it('returns the raw integrity_check lines in integrity_result', async () => {
    mockExec.mockReset();
    mockExec
      .mockResolvedValueOnce({
        stdout:   'row 1 missing from index\nwrong count\n',
        stderr:   '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({ stdout: '0|5|5\n', stderr: '', exitCode: 0 });

    const result = await handler();
    expect(result.integrity_result).toContain('row 1 missing from index');
    expect(result.integrity_result).toContain('wrong count');
  });

  it('integrity_result is "ok" for a healthy database', async () => {
    const result = await handler();
    expect(result.integrity_result).toBe('ok');
  });

  it('adds an error entry when is_healthy is false', async () => {
    mockExec.mockReset();
    mockExec
      .mockResolvedValueOnce({
        stdout:   'row 1 missing from index\n',
        stderr:   '',
        exitCode: 0,
      })
      .mockResolvedValueOnce({ stdout: '0|5|5\n', stderr: '', exitCode: 0 });

    const result = await handler();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/integrity/i);
  });
});

// ---------------------------------------------------------------------------
// AC3 — WAL checkpoint command when run_wal_checkpoint: true
// ---------------------------------------------------------------------------

describe('AC3 — WAL checkpoint execution', () => {
  it('runs wal_checkpoint(PASSIVE) when run_wal_checkpoint is true', async () => {
    await handler();
    expect(mockExec.mock.calls[1][0]).toBe(
      'sqlite3 /home/baanbaan/app/data/baanbaan.db "PRAGMA wal_checkpoint(PASSIVE)"'
    );
  });

  it('sets wal_checkpoint.ran: true when the checkpoint ran', async () => {
    const result = await handler();
    expect(result.wal_checkpoint.ran).toBe(true);
  });

  it('parses checkpoint output into busy, log, checkpointed fields', async () => {
    const result = await handler();
    expect(result.wal_checkpoint.busy).toBe(0);
    expect(result.wal_checkpoint.log).toBe(5);
    expect(result.wal_checkpoint.checkpointed).toBe(5);
  });

  it('parses a non-zero busy value correctly', async () => {
    mockExec.mockReset();
    mockExec
      .mockResolvedValueOnce({ stdout: 'ok\n',    stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '1|10|8\n', stderr: '', exitCode: 0 });

    const result = await handler();
    expect(result.wal_checkpoint.busy).toBe(1);
    expect(result.wal_checkpoint.log).toBe(10);
    expect(result.wal_checkpoint.checkpointed).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// AC4 — WAL checkpoint skipped when run_wal_checkpoint: false
// ---------------------------------------------------------------------------

describe('AC4 — WAL checkpoint skipped', () => {
  beforeEach(() => {
    mockGetConfig.mockReturnValue(CONFIG_NO_WAL);
    mockExec.mockReset();
    mockExec.mockResolvedValueOnce({ stdout: 'ok\n', stderr: '', exitCode: 0 });
  });

  it('does not call exec a second time when run_wal_checkpoint is false', async () => {
    await handler();
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it('sets wal_checkpoint.ran: false when skipped', async () => {
    const result = await handler();
    expect(result.wal_checkpoint.ran).toBe(false);
  });

  it('sets busy, log, checkpointed to null when skipped', async () => {
    const result = await handler();
    expect(result.wal_checkpoint.busy).toBeNull();
    expect(result.wal_checkpoint.log).toBeNull();
    expect(result.wal_checkpoint.checkpointed).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC5 — return shape
// ---------------------------------------------------------------------------

describe('AC5 — return shape', () => {
  it('returns is_healthy, integrity_result, wal_checkpoint, errors, checked_at', async () => {
    const result = await handler();
    expect(result).toHaveProperty('is_healthy');
    expect(result).toHaveProperty('integrity_result');
    expect(result).toHaveProperty('wal_checkpoint');
    expect(result).toHaveProperty('errors');
    expect(result).toHaveProperty('checked_at');
  });

  it('errors is an empty array for a fully healthy run', async () => {
    const result = await handler();
    expect(result.errors).toEqual([]);
  });

  it('checked_at is an ISO 8601 date string', async () => {
    const result = await handler();
    expect(() => new Date(result.checked_at)).not.toThrow();
    expect(new Date(result.checked_at).toISOString()).toBe(result.checked_at);
  });
});

// ---------------------------------------------------------------------------
// AC6 — SSH exec failure handling
// ---------------------------------------------------------------------------

describe('AC6 — SSH exec failure handling', () => {
  it('throws when integrity_check exits with non-zero code', async () => {
    mockExec.mockReset();
    mockExec.mockResolvedValueOnce({
      stdout:   '',
      stderr:   'unable to open database',
      exitCode: 1,
    });

    await expect(handler()).rejects.toThrow(/sqlite3 exited with code 1/);
  });

  it('adds an error and sets wal_checkpoint.ran: false when checkpoint exec fails', async () => {
    mockExec.mockReset();
    mockExec
      .mockResolvedValueOnce({ stdout: 'ok\n', stderr: '',        exitCode: 0 })
      .mockRejectedValueOnce(new Error('SSH channel closed'));

    const result = await handler();
    expect(result.wal_checkpoint.ran).toBe(false);
    expect(result.errors.some(e => /SSH channel closed/i.test(e))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC7 — module exports
// ---------------------------------------------------------------------------

describe('AC7 — module exports', () => {
  const tool = require('../../src/tools/db-integrity');

  it("exports riskLevel: 'read'", () => {
    expect(tool.riskLevel).toBe('read');
  });

  it("exports name: 'db_integrity'", () => {
    expect(tool.name).toBe('db_integrity');
  });

  it('exports schema with description and inputSchema', () => {
    expect(tool.schema).toHaveProperty('description');
    expect(tool.schema).toHaveProperty('inputSchema');
  });

  it('exports handler as a function', () => {
    expect(typeof tool.handler).toBe('function');
  });
});
