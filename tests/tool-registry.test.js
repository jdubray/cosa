'use strict';

// ---------------------------------------------------------------------------
// Mock: ../config/cosa.config
//
// `mockGetConfig` starts with 'mock' — exempt from Jest's hoisting TDZ rule,
// so it can be referenced inside the jest.mock() factory body.
// ---------------------------------------------------------------------------

const mockGetConfig = jest.fn();

jest.mock('../config/cosa.config', () => ({
  getConfig: (...args) => mockGetConfig(...args),
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

const { register, getSchemas, dispatch, _reset } = require('../src/tool-registry');

// ---------------------------------------------------------------------------
// Config fixture helpers
// ---------------------------------------------------------------------------

/**
 * Return a mock config where the given tool names have enabled: true.
 *
 * @param {...string} names
 * @returns {object}
 */
function configWithEnabled(...names) {
  const tools = {};
  names.forEach(n => { tools[n] = { enabled: true }; });
  return { appliance: { tools } };
}

/**
 * Return a mock config where the given tool names have enabled: false.
 *
 * @param {...string} names
 * @returns {object}
 */
function configWithDisabled(...names) {
  const tools = {};
  names.forEach(n => { tools[n] = { enabled: false }; });
  return { appliance: { tools } };
}

/** Return a config with an empty tools section. */
function configNoTools() {
  return { appliance: { tools: {} } };
}

// ---------------------------------------------------------------------------
// Schema fixtures
// ---------------------------------------------------------------------------

/** Schema for a tool that requires a single string field `message`. */
const SIMPLE_SCHEMA = {
  description: 'A simple test tool that echoes a message.',
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string' },
    },
    required: ['message'],
    additionalProperties: false,
  },
};

/** Schema matching the Phase 1 health_check tool (no required inputs). */
const NO_INPUT_SCHEMA = {
  description: 'Run a health check against the appliance.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
};

/** Schema with a numeric field to test type validation. */
const TYPED_SCHEMA = {
  description: 'A tool with a required integer field.',
  inputSchema: {
    type: 'object',
    properties: {
      count: { type: 'integer', minimum: 1 },
    },
    required: ['count'],
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  _reset();
  mockGetConfig.mockReturnValue(configWithEnabled('echo', 'health_check', 'typed_tool'));
});

afterEach(() => {
  _reset();
});

// ---------------------------------------------------------------------------
// AC1 — register()
// ---------------------------------------------------------------------------

describe('register()', () => {
  it('adds a tool to the registry when enabled: true in config', () => {
    register('echo', SIMPLE_SCHEMA, jest.fn());
    expect(getSchemas()).toHaveLength(1);
    expect(getSchemas()[0].name).toBe('echo');
  });

  it('does not register a tool when enabled: false in config', () => {
    mockGetConfig.mockReturnValue(configWithDisabled('echo'));
    register('echo', SIMPLE_SCHEMA, jest.fn());
    expect(getSchemas()).toHaveLength(0);
  });

  it('does not register a tool when the tool name is absent from config', () => {
    mockGetConfig.mockReturnValue(configNoTools());
    register('echo', SIMPLE_SCHEMA, jest.fn());
    expect(getSchemas()).toHaveLength(0);
  });

  it('does not register when the tools section is absent entirely', () => {
    mockGetConfig.mockReturnValue({ appliance: {} });
    register('echo', SIMPLE_SCHEMA, jest.fn());
    expect(getSchemas()).toHaveLength(0);
  });

  it('overwrites a previous registration for the same name', () => {
    const handler1 = jest.fn().mockResolvedValue({ v: 1 });
    const handler2 = jest.fn().mockResolvedValue({ v: 2 });
    register('echo', SIMPLE_SCHEMA, handler1);
    register('echo', SIMPLE_SCHEMA, handler2);
    expect(getSchemas()).toHaveLength(1);
  });

  it('can register multiple tools independently', () => {
    register('echo',         SIMPLE_SCHEMA,   jest.fn());
    register('health_check', NO_INPUT_SCHEMA, jest.fn());
    expect(getSchemas()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// AC2 — getSchemas()
// ---------------------------------------------------------------------------

describe('getSchemas()', () => {
  it('returns an empty array when no tools are registered', () => {
    expect(getSchemas()).toEqual([]);
  });

  it('returns tool definitions in Anthropic tool_use format', () => {
    register('echo', SIMPLE_SCHEMA, jest.fn());
    const [schema] = getSchemas();

    expect(schema).toMatchObject({
      name:         'echo',
      description:  SIMPLE_SCHEMA.description,
      input_schema: SIMPLE_SCHEMA.inputSchema,
    });
  });

  it('uses snake_case "input_schema" key (not camelCase "inputSchema")', () => {
    register('echo', SIMPLE_SCHEMA, jest.fn());
    const [schema] = getSchemas();
    expect(schema).toHaveProperty('input_schema');
    expect(schema).not.toHaveProperty('inputSchema');
  });

  it('does not include disabled tools', () => {
    mockGetConfig.mockReturnValue({
      appliance: {
        tools: {
          echo:         { enabled: true  },
          health_check: { enabled: false },
        },
      },
    });
    register('echo',         SIMPLE_SCHEMA,   jest.fn());
    register('health_check', NO_INPUT_SCHEMA, jest.fn());

    const names = getSchemas().map(s => s.name);
    expect(names).toContain('echo');
    expect(names).not.toContain('health_check');
  });
});

// ---------------------------------------------------------------------------
// AC3 — dispatch() — valid input
// ---------------------------------------------------------------------------

describe('dispatch() — valid input', () => {
  it('calls the handler with the validated input', async () => {
    const handler = jest.fn().mockResolvedValue({ result: 'ok' });
    register('echo', SIMPLE_SCHEMA, handler);

    await dispatch('echo', { message: 'hello' });

    expect(handler).toHaveBeenCalledWith({ message: 'hello' });
  });

  it('returns the handler result', async () => {
    const handler = jest.fn().mockResolvedValue({ status: 'healthy' });
    register('health_check', NO_INPUT_SCHEMA, handler);

    const result = await dispatch('health_check', {});
    expect(result).toEqual({ status: 'healthy' });
  });

  it('awaits async handlers', async () => {
    const handler = jest.fn(async () => {
      await new Promise(r => setTimeout(r, 5));
      return { deferred: true };
    });
    register('echo', SIMPLE_SCHEMA, handler);

    const result = await dispatch('echo', { message: 'async' });
    expect(result).toEqual({ deferred: true });
  });

  it('accepts a tool with no required inputs', async () => {
    const handler = jest.fn().mockResolvedValue({ ok: true });
    register('health_check', NO_INPUT_SCHEMA, handler);

    await expect(dispatch('health_check', {})).resolves.toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// AC4 — dispatch() — unknown tool
// ---------------------------------------------------------------------------

describe('dispatch() — unknown tool name (AC4)', () => {
  it('throws when the tool name is not registered', async () => {
    await expect(dispatch('nonexistent', {})).rejects.toThrow('Unknown tool: "nonexistent"');
  });

  it('throws an error with code TOOL_NOT_FOUND', async () => {
    await expect(dispatch('nonexistent', {})).rejects.toMatchObject({
      code:     'TOOL_NOT_FOUND',
      toolName: 'nonexistent',
    });
  });

  it('throws for a tool that was disabled and therefore never registered', async () => {
    mockGetConfig.mockReturnValue(configWithDisabled('echo'));
    register('echo', SIMPLE_SCHEMA, jest.fn());

    await expect(dispatch('echo', { message: 'hi' })).rejects.toMatchObject({
      code: 'TOOL_NOT_FOUND',
    });
  });
});

// ---------------------------------------------------------------------------
// AC5 — dispatch() — schema validation failure
// ---------------------------------------------------------------------------

describe('dispatch() — invalid input (AC5)', () => {
  beforeEach(() => {
    register('echo', SIMPLE_SCHEMA, jest.fn());
    register('typed_tool', TYPED_SCHEMA, jest.fn());
  });

  it('throws when a required field is missing', async () => {
    await expect(dispatch('echo', {})).rejects.toThrow(/Invalid input for tool "echo"/);
  });

  it('throws an error with code TOOL_INPUT_INVALID', async () => {
    await expect(dispatch('echo', {})).rejects.toMatchObject({
      code:     'TOOL_INPUT_INVALID',
      toolName: 'echo',
    });
  });

  it('includes a validationErrors array on the thrown error', async () => {
    let thrown;
    try {
      await dispatch('echo', {});
    } catch (err) {
      thrown = err;
    }
    expect(thrown.validationErrors).toBeDefined();
    expect(Array.isArray(thrown.validationErrors)).toBe(true);
    expect(thrown.validationErrors.length).toBeGreaterThan(0);
  });

  it('throws when a field has the wrong type', async () => {
    await expect(dispatch('echo', { message: 42 }))
      .rejects.toMatchObject({ code: 'TOOL_INPUT_INVALID' });
  });

  it('throws when additionalProperties is false and an extra field is present', async () => {
    await expect(dispatch('echo', { message: 'hi', extra: true }))
      .rejects.toMatchObject({ code: 'TOOL_INPUT_INVALID' });
  });

  it('throws when an integer field is below its minimum', async () => {
    await expect(dispatch('typed_tool', { count: 0 }))
      .rejects.toMatchObject({ code: 'TOOL_INPUT_INVALID' });
  });

  it('does not call the handler when validation fails', async () => {
    const handler = jest.fn();
    _reset();
    mockGetConfig.mockReturnValue(configWithEnabled('echo'));
    register('echo', SIMPLE_SCHEMA, handler);

    await expect(dispatch('echo', {})).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC6 — only enabled tools in getSchemas()
// ---------------------------------------------------------------------------

describe('AC6 — enabled flag controls registration', () => {
  it('all three Phase 1 tool names are registered when enabled', () => {
    mockGetConfig.mockReturnValue(
      configWithEnabled('health_check', 'db_query', 'db_integrity')
    );
    register('health_check', NO_INPUT_SCHEMA, jest.fn());
    register('db_query',     SIMPLE_SCHEMA,   jest.fn());
    register('db_integrity', SIMPLE_SCHEMA,   jest.fn());

    const names = getSchemas().map(s => s.name);
    expect(names).toEqual(
      expect.arrayContaining(['health_check', 'db_query', 'db_integrity'])
    );
    expect(names).toHaveLength(3);
  });

  it('disabling one tool excludes it while others remain', () => {
    mockGetConfig.mockReturnValue({
      appliance: {
        tools: {
          health_check: { enabled: true  },
          db_query:     { enabled: false },
          db_integrity: { enabled: true  },
        },
      },
    });
    register('health_check', NO_INPUT_SCHEMA, jest.fn());
    register('db_query',     SIMPLE_SCHEMA,   jest.fn());
    register('db_integrity', SIMPLE_SCHEMA,   jest.fn());

    const names = getSchemas().map(s => s.name);
    expect(names).toContain('health_check');
    expect(names).not.toContain('db_query');
    expect(names).toContain('db_integrity');
  });
});
