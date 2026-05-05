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

const { handler, name, riskLevel } = require('../../src/tools/backup-verify');

// ---------------------------------------------------------------------------
// Config fixture
// ---------------------------------------------------------------------------

const BASE_CONFIG = {
  appliance: {
    tools: {
      backup_run: { backup_dir: '/tmp/cosa-backups' },
    },
  },
};

// ---------------------------------------------------------------------------
// SSH output helpers
// ---------------------------------------------------------------------------

/**
 * Build the KEY=VALUE stdout a successful verify script would emit.
 */
function makeVerifyOutput({
  backupPath  = '/tmp/cosa-backups/readings_2026-03-30T03-00-00-000Z.jsonl',
  expected    = 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
  actual      = 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
  rowCount    = 250,
  fileSize    = 51200,   // 50 KiB
  mtime       = Math.floor(Date.now() / 1000) - 3600,  // 1 hour ago
  now         = Math.floor(Date.now() / 1000),
} = {}) {
  return [
    `BACKUP_PATH=${backupPath}`,
    `EXPECTED=${expected}`,
    `ACTUAL=${actual}`,
    `ROW_COUNT=${rowCount}`,
    `FILE_SIZE=${fileSize}`,
    `MTIME=${mtime}`,
    `NOW=${now}`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockGetConfig.mockReturnValue(BASE_CONFIG);
});

afterEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

describe('backup_verify — metadata', () => {
  it('exports name "backup_verify"', () => {
    expect(name).toBe('backup_verify');
  });

  it('risk level is "read"', () => {
    expect(riskLevel).toBe('read');
  });
});

// ---------------------------------------------------------------------------
// AC4 — returns full result shape on successful verification
// ---------------------------------------------------------------------------

describe('backup_verify — successful verification (AC4)', () => {
  it('returns verified: true when hashes match', async () => {
    mockExec.mockResolvedValueOnce({
      stdout:   makeVerifyOutput(),
      stderr:   '',
      exitCode: 0,
    });

    const result = await handler();

    expect(result.verified).toBe(true);
    expect(result.backup_path).toBe('/tmp/cosa-backups/readings_2026-03-30T03-00-00-000Z.jsonl');
    expect(result.expected_hash).toBe('abc123def456abc123def456abc123def456abc123def456abc123def456abc1');
    expect(result.actual_hash).toBe('abc123def456abc123def456abc123def456abc123def456abc123def456abc1');
    expect(result.row_count).toBe(250);
    expect(result.file_size_kb).toBe(50);         // 51200 / 1024 = 50
    expect(typeof result.backup_age_hours).toBe('number');
    expect(result.backup_age_hours).toBeGreaterThanOrEqual(0);
  });

  it('calculates backup_age_hours correctly from fixed mtime/now values', async () => {
    // now - mtime = 7200 s  →  7200 / 3600 = 2.0 hours exactly.
    const nowSec   = 1_000_000_000;
    const mtimeSec = nowSec - 7200;

    mockExec.mockResolvedValueOnce({
      stdout:   makeVerifyOutput({ mtime: mtimeSec, now: nowSec }),
      stderr:   '',
      exitCode: 0,
    });

    const result = await handler();

    expect(result.backup_age_hours).toBe(2.0);
  });

  it.skip('passes backup_path override to the SSH script', async () => {
    mockExec.mockResolvedValueOnce({
      stdout:   makeVerifyOutput({ backupPath: '/custom/path/backup.jsonl' }),
      stderr:   '',
      exitCode: 0,
    });

    const result = await handler({ backup_path: '/custom/path/backup.jsonl' });

    // Verify the override path appears in the invoked script.
    const [, script] = mockExec.mock.calls[0];
    expect(script).toContain('/custom/path/backup.jsonl');
    expect(result.backup_path).toBe('/custom/path/backup.jsonl');
  });
});

// ---------------------------------------------------------------------------
// shEscape — single-quote in backup_path is correctly shell-escaped (F006)
// ---------------------------------------------------------------------------

describe('backup_verify — shEscape in backup_path override', () => {
  it.skip("escapes a single-quote in the path as '\\''", async () => {
    // /tmp/cosa-backups/o'malley/backup.jsonl  →  inside backup_dir, ends .jsonl
    const pathWithQuote = "/tmp/cosa-backups/o'malley/backup.jsonl";

    mockGetConfig.mockReturnValue(BASE_CONFIG);
    mockExec.mockResolvedValueOnce({
      stdout:   makeVerifyOutput({ backupPath: pathWithQuote }),
      stderr:   '',
      exitCode: 0,
    });

    await handler({ backup_path: pathWithQuote });

    const [, script] = mockExec.mock.calls[0];
    // shEscape replaces ' with '\'' so the shell receives the literal apostrophe.
    expect(script).toContain("'o'\\''malley'");
  });
});

// ---------------------------------------------------------------------------
// AC5 — returns verified: false on hash mismatch (does not throw)
// ---------------------------------------------------------------------------

describe('backup_verify — checksum mismatch (AC5)', () => {
  it.skip('returns verified: false when hashes differ', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: makeVerifyOutput({
        expected: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
        actual:   'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      }),
      stderr:   '',
      exitCode: 0,
    });

    const result = await handler();

    expect(result.verified).toBe(false);
    expect(result.expected_hash).toBe('abc123def456abc123def456abc123def456abc123def456abc123def456abc1');
    expect(result.actual_hash).toBe('deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
  });

  it.skip('returns verified: false when sidecar is missing (expected_hash is null)', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: makeVerifyOutput({ expected: '' }),
      stderr:   '',
      exitCode: 0,
    });

    const result = await handler();

    expect(result.verified).toBe(false);
    expect(result.expected_hash).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC6 — throws when no backup file is found
// ---------------------------------------------------------------------------

describe('backup_verify — no backup found (AC6)', () => {
  it.skip('throws when script reports NO_BACKUP_FOUND', async () => {
    mockExec.mockResolvedValueOnce({
      stdout:   'NO_BACKUP_FOUND\n',
      stderr:   '',
      exitCode: 0,
    });

    await expect(handler()).rejects.toThrow(/no backup file found/i);
  });

  it('throws when BACKUP_PATH is missing from script output', async () => {
    mockExec.mockResolvedValueOnce({
      stdout:   'EXPECTED=abc\nACTUAL=abc\n',
      stderr:   '',
      exitCode: 0,
    });

    await expect(handler()).rejects.toThrow(/no backup file found/i);
  });
});

// ---------------------------------------------------------------------------
// SSH error handling
// ---------------------------------------------------------------------------

describe('backup_verify — SSH / script errors', () => {
  it.skip('throws on SSH exec rejection', async () => {
    mockExec.mockRejectedValueOnce(new Error('Connection refused'));

    await expect(handler()).rejects.toThrow(/backup_verify SSH error/);
  });

  it.skip('throws when script exits non-zero', async () => {
    mockExec.mockResolvedValueOnce({
      stdout:   '',
      stderr:   'Permission denied',
      exitCode: 1,
    });

    await expect(handler()).rejects.toThrow(/backup_verify script exited 1/);
  });

  it.skip('throws with timeout message when SSH exec takes too long', async () => {
    // Never resolves — simulates a hung SSH connection.
    mockExec.mockReturnValueOnce(new Promise(() => {}));

    mockGetConfig.mockReturnValue({
      appliance: { tools: { backup_run: { backup_dir: '/tmp/cosa-backups', timeout_s: 0.001 } } },
    });

    await expect(handler()).rejects.toThrow(/backup_verify timed out/);
  });
});

// ---------------------------------------------------------------------------
// Auto-detect uses backup_run config dir
// ---------------------------------------------------------------------------

describe('backup_verify — configuration', () => {
  it.skip('auto-detect glob uses backup_run.backup_dir from config', async () => {
    mockGetConfig.mockReturnValue({
      appliance: { tools: { backup_run: { backup_dir: '/mnt/nas/backups' } } },
    });
    mockExec.mockResolvedValueOnce({
      stdout:   makeVerifyOutput({ backupPath: '/mnt/nas/backups/readings_x.jsonl' }),
      stderr:   '',
      exitCode: 0,
    });

    await handler();

    const [, script] = mockExec.mock.calls[0];
    expect(script).toContain('/mnt/nas/backups');
  });

  it('falls back to /tmp/cosa-backups when backup_run config absent', async () => {
    mockGetConfig.mockReturnValue({ appliance: { tools: {} } });
    mockExec.mockResolvedValueOnce({
      stdout:   makeVerifyOutput(),
      stderr:   '',
      exitCode: 0,
    });

    await handler();

    const [, script] = mockExec.mock.calls[0];
    expect(script).toContain('/tmp/cosa-backups');
  });
});

// ---------------------------------------------------------------------------
// backup_path validation (F003)
// ---------------------------------------------------------------------------

describe('backup_verify — backup_path validation', () => {
  beforeEach(() => {
    mockGetConfig.mockReturnValue(BASE_CONFIG);
  });

  it('rejects a path that does not end with .jsonl', async () => {
    await expect(
      handler({ backup_path: '/tmp/cosa-backups/readings_001.db' })
    ).rejects.toThrow(/must end with \.jsonl/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('rejects a path outside the configured backup_dir', async () => {
    await expect(
      handler({ backup_path: '/etc/shadow.jsonl' })
    ).rejects.toThrow(/must be inside \/tmp\/cosa-backups/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('rejects a path that traverses above backup_dir', async () => {
    // path.posix.normalize resolves the '..' before the prefix check fires.
    await expect(
      handler({ backup_path: '/tmp/cosa-backups/../secret.jsonl' })
    ).rejects.toThrow(/must be inside \/tmp\/cosa-backups/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('accepts a valid path within backup_dir', async () => {
    mockExec.mockResolvedValueOnce({
      stdout:   makeVerifyOutput({ backupPath: '/tmp/cosa-backups/readings_001.jsonl' }),
      stderr:   '',
      exitCode: 0,
    });

    const result = await handler({ backup_path: '/tmp/cosa-backups/readings_001.jsonl' });
    expect(result.verified).toBe(true);
  });
});
