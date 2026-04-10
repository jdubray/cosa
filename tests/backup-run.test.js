'use strict';

jest.mock('../src/ssh-backend');
jest.mock('../config/cosa.config');

const sshBackend    = require('../src/ssh-backend');
const { getConfig } = require('../config/cosa.config');
const { handler }   = require('../src/tools/backup-run');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DB_PATH    = '/data/appliance.db';
const BACKUP_DIR = '/tmp/cosa-backups';

function setConfig(overrides = {}) {
  getConfig.mockReturnValue({
    appliance: {
      database: { path: DB_PATH },
      tools: {
        backup_run: {
          backup_dir: BACKUP_DIR,
          timeout_s:  30,
          tables:     ['readings'],   // explicit — no appliance-specific default in the tool
          ...overrides,
        },
      },
    },
  });
}

/** Simulate a successful SSH exec that returns N pairs of rowCount/checksum. */
function mockSshSuccess(pairs = [{ rowCount: 10, checksum: 'abc123' }]) {
  const lines = pairs.flatMap(p => [`${p.rowCount}`, p.checksum]);
  sshBackend.exec = jest.fn().mockResolvedValue({
    stdout:   lines.join('\n') + '\n',
    stderr:   '',
    exitCode: 0,
  });
}

/** Simulate a failed SSH exec (non-zero exit). */
function mockSshFailure(exitCode = 127, stderr = 'bash: node: command not found') {
  sshBackend.exec = jest.fn().mockResolvedValue({
    stdout:   '',
    stderr,
    exitCode,
  });
}

/** Simulate a network-level SSH exception. */
function mockSshError(message = 'Connection refused') {
  sshBackend.exec = jest.fn().mockRejectedValue(new Error(message));
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  setConfig();
});

// ===========================================================================
// AC1 — JS runtime resolution
// ===========================================================================

describe('AC1 — JS runtime resolution', () => {
  test('uses auto-detect when js_runtime not configured', async () => {
    mockSshSuccess();

    await handler();

    const script = sshBackend.exec.mock.calls[0][1];
    expect(script).toContain('$(which bun 2>/dev/null || which node 2>/dev/null || echo \'\')');
  });

  test('uses configured js_runtime directly when set', async () => {
    setConfig({ js_runtime: 'bun' });
    mockSshSuccess();

    await handler();

    const script = sshBackend.exec.mock.calls[0][1];
    expect(script).toContain("JSRT='bun'");
    expect(script).not.toContain('which bun');
  });

  test('script includes guard that exits 1 if JSRT is empty', async () => {
    mockSshSuccess();

    await handler();

    const script = sshBackend.exec.mock.calls[0][1];
    expect(script).toContain('[ -z "$JSRT" ]');
    expect(script).toContain('exit 1');
  });
});

// ===========================================================================
// AC2 — tables must be explicitly configured
// ===========================================================================

describe('AC2 — tables configuration required', () => {
  test('returns success: false with a clear error when tables not configured', async () => {
    getConfig.mockReturnValue({
      appliance: {
        database: { path: DB_PATH },
        tools: { backup_run: { backup_dir: BACKUP_DIR, timeout_s: 30 } },
      },
    });

    const result = await handler();

    expect(result.success).toBe(false);
    expect(result.backup_files).toEqual([]);
    expect(result.error).toContain('backup_run.tables');
    expect(result.error).toContain('appliance.yaml');
    expect(sshBackend.exec).not.toHaveBeenCalled();
  });

  test('returns success: false when tables is an empty array', async () => {
    getConfig.mockReturnValue({
      appliance: {
        database: { path: DB_PATH },
        tools: { backup_run: { backup_dir: BACKUP_DIR, tables: [] } },
      },
    });

    const result = await handler();

    expect(result.success).toBe(false);
    expect(result.error).toContain('backup_run.tables');
    expect(sshBackend.exec).not.toHaveBeenCalled();
  });

  test('exports a single configured table', async () => {
    setConfig({ tables: ['readings'] });
    mockSshSuccess([{ rowCount: 42, checksum: 'aabbcc' }]);

    const result = await handler();

    expect(result.success).toBe(true);
    expect(result.backup_files).toHaveLength(1);
    expect(result.backup_files[0]).toMatchObject({
      table:     'readings',
      row_count: 42,
      checksum:  'aabbcc',
    });
    expect(result.backup_files[0].path).toMatch(/readings_.*\.jsonl$/);
    const script = sshBackend.exec.mock.calls[0][1];
    expect(script).toContain('SELECT * FROM readings');
  });
});

// ===========================================================================
// AC3 — multi-table
// ===========================================================================

describe('AC3 — multi-table', () => {
  const TABLES = ['orders', 'merchants', 'employees'];

  test('generates one SELECT and one output block per table', async () => {
    setConfig({ tables: TABLES });
    mockSshSuccess([
      { rowCount: 100, checksum: 'hash1' },
      { rowCount:  20, checksum: 'hash2' },
      { rowCount:   5, checksum: 'hash3' },
    ]);

    await handler();

    const script = sshBackend.exec.mock.calls[0][1];
    for (const table of TABLES) {
      expect(script).toContain(`SELECT * FROM ${table}`);
    }
  });

  test('returns one entry per table in backup_files', async () => {
    setConfig({ tables: TABLES });
    mockSshSuccess([
      { rowCount: 100, checksum: 'hash1' },
      { rowCount:  20, checksum: 'hash2' },
      { rowCount:   5, checksum: 'hash3' },
    ]);

    const result = await handler();

    expect(result.success).toBe(true);
    expect(result.backup_files).toHaveLength(3);

    expect(result.backup_files[0]).toMatchObject({ table: 'orders',    row_count: 100, checksum: 'hash1' });
    expect(result.backup_files[1]).toMatchObject({ table: 'merchants', row_count:  20, checksum: 'hash2' });
    expect(result.backup_files[2]).toMatchObject({ table: 'employees', row_count:   5, checksum: 'hash3' });
  });

  test('each backup path includes the table name', async () => {
    setConfig({ tables: TABLES });
    mockSshSuccess([
      { rowCount: 1, checksum: 'a' },
      { rowCount: 2, checksum: 'b' },
      { rowCount: 3, checksum: 'c' },
    ]);

    const result = await handler();

    for (const { table, path } of result.backup_files) {
      expect(path).toContain(table);
      expect(path).toMatch(/\.jsonl$/);
    }
  });

  test('all backup paths share the same timestamp slug', async () => {
    setConfig({ tables: TABLES });
    mockSshSuccess([
      { rowCount: 1, checksum: 'a' },
      { rowCount: 2, checksum: 'b' },
      { rowCount: 3, checksum: 'c' },
    ]);

    const result = await handler();

    // Extract the timestamp portion from each path (between last '_' and '.jsonl')
    const slugs = result.backup_files.map(f => f.path.replace(/.*_/, '').replace('.jsonl', ''));
    expect(new Set(slugs).size).toBe(1); // all identical
  });
});

// ===========================================================================
// AC4 — script failure
// ===========================================================================

describe('AC4 — script failure', () => {
  test('returns success: false on non-zero exit', async () => {
    mockSshFailure(127, 'bash: line 3: node: command not found');

    const result = await handler();

    expect(result.success).toBe(false);
    expect(result.backup_files).toEqual([]);
    expect(result.error).toContain('127');
    expect(result.error).toContain('node: command not found');
  });

  test('returns success: false on no-such-table error', async () => {
    mockSshFailure(1, 'Error: in prepare, no such table: readings');

    const result = await handler();

    expect(result.success).toBe(false);
    expect(result.error).toContain('no such table');
  });

  test('returns success: false on SSH network error', async () => {
    mockSshError('Connection refused');

    const result = await handler();

    expect(result.success).toBe(false);
    expect(result.backup_files).toEqual([]);
    expect(result.error).toContain('Connection refused');
  });

  test('includes timing fields even on failure', async () => {
    mockSshFailure(1, 'something broke');

    const result = await handler();

    expect(result.started_at).toBeTruthy();
    expect(result.completed_at).toBeTruthy();
    expect(typeof result.duration_ms).toBe('number');
  });
});

// ===========================================================================
// AC5 — result shape on success
// ===========================================================================

describe('AC5 — result shape on success', () => {
  test('includes started_at, completed_at, duration_ms', async () => {
    mockSshSuccess();

    const result = await handler();

    expect(result.started_at).toBeTruthy();
    expect(result.completed_at).toBeTruthy();
    expect(typeof result.duration_ms).toBe('number');
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  test('backup_files path uses configured backup_dir', async () => {
    mockSshSuccess();

    const result = await handler();

    expect(result.backup_files[0].path).toMatch(new RegExp(`^${BACKUP_DIR}/`));
  });

  test('sends bash -s as the SSH command with the script as stdin', async () => {
    mockSshSuccess();

    await handler();

    expect(sshBackend.exec).toHaveBeenCalledWith(
      'bash -s',
      expect.stringContaining('set -euo pipefail')
    );
  });

  test('JS transformer guards against empty input (sqlite3 outputs 0 bytes for empty tables)', async () => {
    mockSshSuccess();

    await handler();

    const script = sshBackend.exec.mock.calls[0][1];
    // Must guard with !d.trim() before JSON.parse to handle 0-byte sqlite3 output
    expect(script).toContain("if(!d.trim())return;");
  });

  test('uses temp file + stdin redirect instead of direct pipe to avoid bash -s contention', async () => {
    mockSshSuccess();

    await handler();

    const script = sshBackend.exec.mock.calls[0][1];
    // Must write sqlite3 output to a temp file first...
    expect(script).toContain('TMPJSON=$(mktemp)');
    expect(script).toMatch(/sqlite3.*>\s*"\$TMPJSON"/);
    // ...then redirect temp file into the JS transformer (not a direct pipe)
    expect(script).toMatch(/"?\$JSRT"?\s+-e\s+.*<\s*"\$TMPJSON"/);
    // Must clean up the temp file
    expect(script).toContain('rm -f "$TMPJSON"');
    // Must NOT have a direct sqlite3 | runtime pipe
    expect(script).not.toMatch(/sqlite3.*\|.*"\$JSRT"/);
  });
});
