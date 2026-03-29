'use strict';

// ---------------------------------------------------------------------------
// Mocks — `mock` prefix exempts from Jest's hoisting TDZ rule.
// ---------------------------------------------------------------------------

// ── fs ───────────────────────────────────────────────────────────────────────
const mockReadFileSync = jest.fn();

jest.mock('fs', () => ({
  readFileSync: (...a) => mockReadFileSync(...a),
}));

// ── tool-registry ─────────────────────────────────────────────────────────────
const mockGetSchemas = jest.fn();

jest.mock('../src/tool-registry', () => ({
  getSchemas: (...a) => mockGetSchemas(...a),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const APPLIANCE_MD = `# Baanbaan Appliance — Identity

**System:** Baanbaan POS Relay
**Runtime:** Bun on Raspberry Pi 4 (ARM64)
**LAN IP:** 192.168.1.10
`;

const TOOL_SCHEMAS = [
  {
    name:         'health_check',
    description:  'Monitor appliance health via SSH and HTTP.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name:         'db_query',
    description:  'Run a read-only SQL query against the appliance database.',
    input_schema: {
      type:       'object',
      properties: { sql: { type: 'string' } },
      required:   ['sql'],
    },
  },
];

const IDENTITY_OPENING =
  'You are COSA (Code-Operate-Secure Agent), an autonomous operations agent managing a software appliance.';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/** @type {{ build: () => string }} */
let contextBuilder;

beforeEach(() => {
  jest.resetModules();
  mockReadFileSync.mockReturnValue(APPLIANCE_MD);
  mockGetSchemas.mockReturnValue(TOOL_SCHEMAS);
  // Re-require after resetModules to get a fresh module with fresh mocks bound.
  contextBuilder = require('../src/context-builder');
});

// ---------------------------------------------------------------------------
// AC1 — build() returns a single string containing all four sections
// ---------------------------------------------------------------------------

describe('AC1 — four sections present', () => {
  test('returns a string', () => {
    expect(typeof contextBuilder.build()).toBe('string');
  });

  test('contains COSA identity text', () => {
    expect(contextBuilder.build()).toContain(IDENTITY_OPENING);
  });

  test('contains APPLIANCE.md content', () => {
    expect(contextBuilder.build()).toContain('Baanbaan POS Relay');
  });

  test('contains tool names from registry', () => {
    const result = contextBuilder.build();
    expect(result).toContain('health_check');
    expect(result).toContain('db_query');
  });

  test('contains an ISO 8601 timestamp', () => {
    const result = contextBuilder.build();
    // Matches e.g. 2026-03-28T14:30:00.000Z
    expect(result).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });
});

// ---------------------------------------------------------------------------
// AC2 — sections are separated by a consistent delimiter
// ---------------------------------------------------------------------------

describe('AC2 — section delimiter', () => {
  test('uses --- as separator between sections', () => {
    const result = contextBuilder.build();
    expect(result).toContain('\n---\n');
  });

  test('has at least three --- separators (four sections → three dividers)', () => {
    const result = contextBuilder.build();
    const count  = (result.match(/\n---\n/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test('identity section comes before appliance section', () => {
    const result      = contextBuilder.build();
    const identityIdx = result.indexOf(IDENTITY_OPENING);
    const applianceIdx = result.indexOf('Baanbaan POS Relay');
    expect(identityIdx).toBeLessThan(applianceIdx);
  });

  test('appliance section comes before tools section', () => {
    const result      = contextBuilder.build();
    const applianceIdx = result.indexOf('Baanbaan POS Relay');
    const toolsIdx    = result.indexOf('health_check');
    expect(applianceIdx).toBeLessThan(toolsIdx);
  });

  test('tools section comes before timestamp section', () => {
    const result    = contextBuilder.build();
    const toolsIdx  = result.indexOf('health_check');
    const tsMatch   = result.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    const tsIdx     = tsMatch ? result.indexOf(tsMatch[0]) : -1;
    expect(toolsIdx).toBeLessThan(tsIdx);
  });
});

// ---------------------------------------------------------------------------
// AC3 — APPLIANCE.md is read from config/APPLIANCE.md
// ---------------------------------------------------------------------------

describe('AC3 — APPLIANCE.md file path', () => {
  test('reads APPLIANCE.md using the correct path', () => {
    contextBuilder.build();
    const [calledPath] = mockReadFileSync.mock.calls[0];
    expect(calledPath).toMatch(/config[/\\]APPLIANCE\.md$/);
  });

  test('reads with utf8 encoding', () => {
    contextBuilder.build();
    const [, encoding] = mockReadFileSync.mock.calls[0];
    expect(encoding).toBe('utf8');
  });

  test('includes the content returned by readFileSync', () => {
    mockReadFileSync.mockReturnValue('# Custom appliance content\n');
    const result = contextBuilder.build();
    expect(result).toContain('# Custom appliance content');
  });
});

// ---------------------------------------------------------------------------
// AC4 — Only enabled tools are included (delegated to toolRegistry.getSchemas)
// ---------------------------------------------------------------------------

describe('AC4 — enabled-only tools via getSchemas', () => {
  test('calls toolRegistry.getSchemas() to get filtered tool list', () => {
    contextBuilder.build();
    expect(mockGetSchemas).toHaveBeenCalledTimes(1);
  });

  test('when getSchemas returns empty array, tools section is still present but empty', () => {
    mockGetSchemas.mockReturnValue([]);
    const result = contextBuilder.build();
    // Should not throw, should still have delimiters
    expect(result).toContain('\n---\n');
  });

  test('when getSchemas returns two tools, both appear in output', () => {
    const result = contextBuilder.build();
    expect(result).toContain('health_check');
    expect(result).toContain('db_query');
  });

  test('includes tool descriptions', () => {
    const result = contextBuilder.build();
    expect(result).toContain('Monitor appliance health via SSH and HTTP.');
    expect(result).toContain('Run a read-only SQL query against the appliance database.');
  });
});

// ---------------------------------------------------------------------------
// AC5 — COSA identity text matches §12.2 exactly
// ---------------------------------------------------------------------------

describe('AC5 — §12.2 identity text', () => {
  const SECTION_12_2 = [
    'You are COSA (Code-Operate-Secure Agent), an autonomous operations agent managing a software appliance.',
    '',
    'Your primary responsibilities:',
    '- Monitor and assess appliance health',
    '- Diagnose issues and propose remedies',
    '- Report findings to the operator via email',
    '- Request operator approval before taking any non-read action',
    '',
    'Your operating principles:',
    '- Default to read-only operations. Never modify state without operator approval.',
    '- Be concise and factual. Operators are busy; surface only what matters.',
    '- When in doubt, ask. It is better to ask for approval than to act without consent.',
    '- Dangerous commands (rm -rf, DROP TABLE, credential exposure) are blocked by the security gate. Never attempt to circumvent it.',
    '- All your actions are logged and auditable. Operate with full transparency.',
    '',
    'Communication style:',
    '- Plain text only. No markdown formatting in emails.',
    '- Lead with the conclusion ("Baanbaan is healthy." / "Alert: POS adapter offline.").',
    '- Follow with evidence and detail.',
    '- End with a clear next-step recommendation if action is needed.',
  ].join('\n');

  test('output contains the complete §12.2 identity block verbatim', () => {
    expect(contextBuilder.build()).toContain(SECTION_12_2);
  });

  test('identity block starts at the beginning of the output', () => {
    const result = contextBuilder.build();
    expect(result.startsWith(SECTION_12_2)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC6 — build() is deterministic for the same config and tool registry state
// ---------------------------------------------------------------------------

describe('AC6 — determinism', () => {
  test('two calls with same mocks produce identical structure (modulo timestamp)', () => {
    // Freeze time so timestamps also match
    const fixedNow = new Date('2026-03-28T12:00:00.000Z');
    jest.spyOn(global, 'Date').mockImplementation(() => fixedNow);
    fixedNow.toISOString = () => '2026-03-28T12:00:00.000Z';

    const r1 = contextBuilder.build();
    const r2 = contextBuilder.build();

    expect(r1).toBe(r2);

    jest.restoreAllMocks();
  });

  test('different tool schemas produce different output', () => {
    const r1 = contextBuilder.build();
    mockGetSchemas.mockReturnValue([
      {
        name:         'db_integrity',
        description:  'Check SQLite integrity.',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
    ]);
    const r2 = contextBuilder.build();

    expect(r1).not.toBe(r2);
    expect(r2).toContain('db_integrity');
    expect(r2).not.toContain('health_check');
  });

  test('different APPLIANCE.md content produces different output', () => {
    const r1 = contextBuilder.build();
    mockReadFileSync.mockReturnValue('# Different appliance\n');
    const r2 = contextBuilder.build();

    expect(r1).not.toBe(r2);
    expect(r2).toContain('# Different appliance');
  });
});
