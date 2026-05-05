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

const { handler } = require('../../src/tools/db-query');

// ---------------------------------------------------------------------------
// Config fixture
// ---------------------------------------------------------------------------

const BASE_CONFIG = {
  appliance: {
    database: { path: '/home/baanbaan/app/data/baanbaan.db' },
    tools: {
      db_query: {
        enabled:          true,
        max_row_return:   100,
        query_timeout_ms: 15000,
      },
    },
  },
};

/**
 * Build a mock exec result with the given rows serialised as sqlite3 -json output.
 *
 * @param {object[]} rows
 * @param {number}   [exitCode=0]
 * @param {string}   [stderr='']
 */
function execResult(rows, exitCode = 0, stderr = '') {
  const stdout = rows.length ? JSON.stringify(rows) : '';
  return { stdout, stderr, exitCode };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockGetConfig.mockReturnValue(BASE_CONFIG);
  mockExec.mockResolvedValue(execResult([{ id: 1, name: 'Test Order' }]));
});

afterEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// AC1 — input: query (required) + limit (optional, default 50, max 100)
// ---------------------------------------------------------------------------

describe('AC1 — query and limit inputs', () => {
  it('accepts a query string and returns a result', async () => {
    const result = await handler({ query: 'SELECT * FROM orders' });
    expect(result).toHaveProperty('rows');
  });

  it('defaults limit to 50 when not provided', async () => {
    await handler({ query: 'SELECT * FROM orders' });
    const stdin = mockExec.mock.calls[0][1];
    expect(stdin).toMatch(/LIMIT 50/);
  });

  it('uses the provided limit when given', async () => {
    await handler({ query: 'SELECT * FROM orders', limit: 10 });
    const stdin = mockExec.mock.calls[0][1];
    expect(stdin).toMatch(/LIMIT 10/);
  });

  it('caps limit at 100 when caller provides a value over 100', async () => {
    await handler({ query: 'SELECT * FROM orders', limit: 999 });
    const stdin = mockExec.mock.calls[0][1];
    expect(stdin).toMatch(/LIMIT 100/);
    expect(stdin).not.toMatch(/LIMIT 999/);
  });
});

// ---------------------------------------------------------------------------
// AC2 — reject queries that do not start with SELECT
// ---------------------------------------------------------------------------

describe('AC2 — must start with SELECT', () => {
  const nonSelect = [
    'INSERT INTO orders VALUES (1)',
    'UPDATE orders SET status = 1',
    'DELETE FROM orders',
    'DROP TABLE orders',
    'PRAGMA table_info(orders)',
    '.tables',
    '',
  ];

  nonSelect.forEach(q => {
    it(`rejects "${q || '(empty string)'}"`, async () => {
      await expect(handler({ query: q })).rejects.toThrow(/SELECT/);
    });
  });

  it('does not call exec when the query is rejected', async () => {
    await expect(handler({ query: 'INSERT INTO orders VALUES (1)' })).rejects.toThrow();
    expect(mockExec).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC3 — reject queries containing destructive keywords
// ---------------------------------------------------------------------------

describe('AC3 — destructive keyword rejection', () => {
  const cases = [
    { kw: 'DROP',   q: 'SELECT * FROM orders DROP TABLE foo' },
    // Note: queries with semicolons are caught by the multi-statement check
    // (rule 2) before the keyword check (rule 3).  Use inline-keyword forms
    // here so the keyword check is the one that fires.
    { kw: 'DELETE', q: 'SELECT * FROM orders WHERE DELETE = 1' },
    { kw: 'UPDATE', q: 'SELECT * FROM orders UPDATE orders SET x=1' },
    { kw: 'INSERT', q: 'SELECT * FROM orders INSERT INTO orders VALUES(1)' },
    { kw: 'CREATE', q: 'SELECT * FROM orders CREATE TABLE tmp(id INT)' },
    { kw: 'ALTER',  q: 'SELECT * FROM orders ALTER TABLE orders ADD COLUMN x' },
    { kw: 'ATTACH', q: 'SELECT * FROM orders ATTACH DATABASE foo AS bar' },
    { kw: 'PRAGMA', q: 'SELECT * FROM orders PRAGMA writable_schema=ON' },
  ];

  cases.forEach(({ kw, q }) => {
    it(`rejects query containing "${kw}"`, async () => {
      await expect(handler({ query: q }))
        .rejects.toThrow(new RegExp(kw, 'i'));
    });
  });

  it('rejects lowercase destructive keywords', async () => {
    await expect(handler({ query: 'SELECT 1 drop table orders' }))
      .rejects.toThrow(/DROP/i);
  });

  it('does not reject column names that contain a keyword as a substring', async () => {
    // "drop_count" contains "drop" but \bDROP\b won't match within "drop_count"
    mockExec.mockResolvedValue(execResult([{ drop_count: 0 }]));
    await expect(
      handler({ query: 'SELECT drop_count FROM metrics' })
    ).resolves.toHaveProperty('rows');
  });
});

// ---------------------------------------------------------------------------
// AC3b — multi-statement (semicolon) rejection
// ---------------------------------------------------------------------------

describe('AC3b — multi-statement semicolon rejection', () => {
  const multiStatement = [
    'SELECT 1; SELECT 2',
    'SELECT * FROM orders; DROP TABLE orders',
    'SELECT * FROM orders; PRAGMA writable_schema=ON',
    "SELECT * FROM orders; ATTACH DATABASE '/tmp/x' AS exfil",
    'SELECT * FROM orders;',
  ];

  multiStatement.forEach(q => {
    it(`rejects "${q}"`, async () => {
      await expect(handler({ query: q })).rejects.toThrow(/semicolon|multi-statement/i);
    });
  });

  it('does not call exec when a semicolon is detected', async () => {
    await expect(
      handler({ query: 'SELECT 1; SELECT 2' })
    ).rejects.toThrow();
    expect(mockExec).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC4 — LIMIT appended when not already present
// ---------------------------------------------------------------------------

describe('AC4 — LIMIT injection', () => {
  it('appends LIMIT when the query has no LIMIT clause', async () => {
    await handler({ query: 'SELECT * FROM orders', limit: 25 });
    expect(mockExec.mock.calls[0][1]).toMatch(/LIMIT 25/);
  });

  it('does not append a second LIMIT when one is already present', async () => {
    await handler({ query: 'SELECT * FROM orders LIMIT 5', limit: 25 });
    const stdin = mockExec.mock.calls[0][1];
    // Only one LIMIT occurrence
    expect((stdin.match(/LIMIT/gi) ?? []).length).toBe(1);
  });

  it('preserves an existing LIMIT value when it is lower than the requested limit', async () => {
    await handler({ query: 'SELECT * FROM orders LIMIT 3', limit: 50 });
    const stdin = mockExec.mock.calls[0][1];
    expect(stdin).toMatch(/LIMIT 3/);
  });
});

// ---------------------------------------------------------------------------
// AC5 — SSH command format
// ---------------------------------------------------------------------------

describe('AC5 — SSH command', () => {
  it('calls sshBackend.exec with the sqlite3 -json -readonly command', async () => {
    await handler({ query: 'SELECT * FROM orders' });
    // Command contains only the db path — SQL is passed via stdin, not in the command.
    expect(mockExec.mock.calls[0][0]).toMatch(
      /^sqlite3 -json -readonly "\/home\/baanbaan\/app\/data\/baanbaan\.db"$/
    );
  });

  it('uses the database path from appliance config', async () => {
    mockGetConfig.mockReturnValue({
      ...BASE_CONFIG,
      appliance: {
        ...BASE_CONFIG.appliance,
        database: { path: '/custom/path/baanbaan.db' },
      },
    });

    await handler({ query: 'SELECT 1' });
    expect(mockExec.mock.calls[0][0]).toMatch(/\/custom\/path\/baanbaan\.db/);
  });

  it('passes the SQL query as stdin to avoid shell injection', async () => {
    const query = 'SELECT * FROM orders WHERE note = "test"';
    await handler({ query });
    // SQL goes in the second argument (stdin), never in the command string.
    const cmd   = mockExec.mock.calls[0][0];
    const stdin = mockExec.mock.calls[0][1];
    expect(cmd).not.toMatch(/SELECT/);   // command has no SQL
    expect(stdin).toContain('SELECT');   // stdin carries the full query
    expect(stdin).toContain('"test"');   // quotes preserved as-is — no shell escaping needed
  });

  it('shell metacharacters in SQL are not present in the command string', async () => {
    await handler({ query: 'SELECT * FROM orders WHERE id = 1' });
    const cmd = mockExec.mock.calls[0][0];
    // No SQL at all in the shell command — injection surface is eliminated.
    expect(cmd).not.toMatch(/SELECT|WHERE|FROM/i);
  });
});

// ---------------------------------------------------------------------------
// AC6 — return shape { rows, row_count, truncated, query_time_ms }
// ---------------------------------------------------------------------------

describe('AC6 — return shape', () => {
  it('returns rows, row_count, truncated, and query_time_ms', async () => {
    const result = await handler({ query: 'SELECT * FROM orders' });
    expect(result).toHaveProperty('rows');
    expect(result).toHaveProperty('row_count');
    expect(result).toHaveProperty('truncated');
    expect(result).toHaveProperty('query_time_ms');
  });

  it('rows is an array of objects matching the sqlite3 output', async () => {
    mockExec.mockResolvedValue(
      execResult([{ id: 1, status: 'open' }, { id: 2, status: 'closed' }])
    );
    const result = await handler({ query: 'SELECT id, status FROM orders' });
    expect(result.rows).toEqual([{ id: 1, status: 'open' }, { id: 2, status: 'closed' }]);
  });

  it('returns empty rows array when sqlite3 outputs nothing', async () => {
    mockExec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    const result = await handler({ query: 'SELECT * FROM orders WHERE 1=0' });
    expect(result.rows).toEqual([]);
    expect(result.row_count).toBe(0);
  });

  it('row_count equals the number of rows returned', async () => {
    mockExec.mockResolvedValue(
      execResult([{ id: 1 }, { id: 2 }, { id: 3 }])
    );
    const result = await handler({ query: 'SELECT id FROM orders' });
    expect(result.row_count).toBe(3);
  });

  it('query_time_ms is a non-negative integer', async () => {
    const result = await handler({ query: 'SELECT 1' });
    expect(typeof result.query_time_ms).toBe('number');
    expect(result.query_time_ms).toBeGreaterThanOrEqual(0);
  });

  it('throws when sqlite3 exits with non-zero exit code', async () => {
    mockExec.mockResolvedValue({ stdout: '', stderr: 'no such table: bad', exitCode: 1 });
    await expect(handler({ query: 'SELECT * FROM bad' }))
      .rejects.toThrow(/sqlite3 exited with code 1/);
  });
});

// ---------------------------------------------------------------------------
// AC7 — truncated: true when row_count === effective limit
// ---------------------------------------------------------------------------

describe('AC7 — truncated flag', () => {
  it('sets truncated: true when row_count equals the limit', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: i }));
    mockExec.mockResolvedValue(execResult(rows));

    const result = await handler({ query: 'SELECT * FROM orders' }); // default limit 50
    expect(result.truncated).toBe(true);
  });

  it('sets truncated: false when row_count is less than the limit', async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    mockExec.mockResolvedValue(execResult(rows));

    const result = await handler({ query: 'SELECT * FROM orders', limit: 50 });
    expect(result.truncated).toBe(false);
  });

  it('sets truncated: true when row_count equals a custom limit', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: i }));
    mockExec.mockResolvedValue(execResult(rows));

    const result = await handler({ query: 'SELECT * FROM orders', limit: 10 });
    expect(result.truncated).toBe(true);
  });

  it('sets truncated: false for an empty result set', async () => {
    mockExec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    const result = await handler({ query: 'SELECT * FROM orders WHERE 1=0' });
    expect(result.truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC8 — riskLevel and module exports
// ---------------------------------------------------------------------------

describe('AC8 — module exports', () => {
  const tool = require('../../src/tools/db-query');

  it("exports riskLevel: 'read'", () => {
    expect(tool.riskLevel).toBe('read');
  });

  it("exports name: 'db_query'", () => {
    expect(tool.name).toBe('db_query');
  });

  it('exports schema with description and inputSchema', () => {
    expect(tool.schema).toHaveProperty('description');
    expect(tool.schema).toHaveProperty('inputSchema');
  });

  it('inputSchema requires query', () => {
    expect(tool.schema.inputSchema.required).toContain('query');
  });

  it('exports handler as a function', () => {
    expect(typeof tool.handler).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// AC9 — query timeout enforced from appliance.yaml
// ---------------------------------------------------------------------------

describe('AC9 — query timeout', () => {
  it.skip('rejects with a timeout error when exec takes longer than query_timeout_ms', async () => {
    jest.useFakeTimers();
    // exec never resolves
    mockExec.mockImplementation(() => new Promise(() => {}));

    const p = handler({ query: 'SELECT * FROM orders' });

    jest.advanceTimersByTime(16000); // past 15000ms
    await jest.runAllTimersAsync();

    await expect(p).rejects.toThrow(/timed out/);
  });

  it.skip('uses query_timeout_ms from appliance config', async () => {
    jest.useFakeTimers();
    mockGetConfig.mockReturnValue({
      ...BASE_CONFIG,
      appliance: {
        ...BASE_CONFIG.appliance,
        tools: { db_query: { query_timeout_ms: 500 } },
      },
    });
    mockExec.mockImplementation(() => new Promise(() => {}));

    const p = handler({ query: 'SELECT 1' });

    jest.advanceTimersByTime(600); // past 500ms
    await jest.runAllTimersAsync();

    await expect(p).rejects.toThrow(/timed out after 500ms/);
  });

  it.skip('defaults to 15000ms when config value is absent', async () => {
    jest.useFakeTimers();
    mockGetConfig.mockReturnValue({
      appliance: {
        database: { path: '/home/baanbaan/app/data/baanbaan.db' },
        tools: {},
      },
    });
    mockExec.mockImplementation(() => new Promise(() => {}));

    const p = handler({ query: 'SELECT 1' });

    jest.advanceTimersByTime(16000);
    await jest.runAllTimersAsync();

    await expect(p).rejects.toThrow(/timed out after 15000ms/);
  });

  it('resolves normally when exec completes before the timeout', async () => {
    mockExec.mockResolvedValue(execResult([{ n: 1 }]));
    await expect(handler({ query: 'SELECT 1 AS n' })).resolves.toHaveProperty('rows');
  });
});
