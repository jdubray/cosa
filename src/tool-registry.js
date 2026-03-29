'use strict';

const Ajv = require('ajv');
const { getConfig } = require('../config/cosa.config');

const ajv = new Ajv({ allErrors: true });

// ---------------------------------------------------------------------------
// Internal registry state
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   schema:    { description: string, inputSchema: object },
 *   validate:  import('ajv').ValidateFunction,
 *   handler:   (input: object) => Promise<object>,
 *   riskLevel: string
 * }} ToolEntry
 */

/** @type {Map<string, ToolEntry>} */
const _registry = new Map();

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/**
 * Build a structured error for an unknown tool name.
 *
 * @param {string} name
 * @returns {Error & { code: 'TOOL_NOT_FOUND', toolName: string }}
 */
function unknownToolError(name) {
  const err = new Error(`Unknown tool: "${name}"`);
  err.code    = 'TOOL_NOT_FOUND';
  err.toolName = name;
  return err;
}

/**
 * Build a structured error for a JSON schema validation failure.
 *
 * @param {string} name
 * @param {import('ajv').ErrorObject[]} errors
 * @returns {Error & { code: 'TOOL_INPUT_INVALID', toolName: string, validationErrors: object[] }}
 */
function validationError(name, errors) {
  const message = ajv.errorsText(errors, { separator: '; ' });
  const err = new Error(`Invalid input for tool "${name}": ${message}`);
  err.code             = 'TOOL_INPUT_INVALID';
  err.toolName         = name;
  err.validationErrors = errors;
  return err;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a tool with the registry.
 *
 * The tool is registered **only** when `appliance.tools.[name].enabled === true`
 * in `config/appliance.yaml`.  Tools that are absent from the config or
 * explicitly set to `enabled: false` are silently skipped, ensuring that the
 * appliance config is the single source of truth for which capabilities are
 * active.
 *
 * @param {string} name - Tool name (must match the key in appliance.yaml tools section).
 * @param {{ description: string, inputSchema: object }} schema
 *   `description` is a human/LLM-readable explanation; `inputSchema` is the
 *   JSON Schema used to validate tool inputs.
 * @param {(input: object) => Promise<object>} handler - Async function that
 *   performs the tool's work and returns a structured result.
 * @param {string} [riskLevel='read'] - Risk classification used by the approval
 *   gate.  One of `'read'`, `'medium'`, `'high'`, or `'critical'`.
 */
function register(name, schema, handler, riskLevel = 'read') {
  const { appliance } = getConfig();
  if (appliance.tools?.[name]?.enabled !== true) return;

  _registry.set(name, {
    schema,
    validate: ajv.compile(schema.inputSchema),
    handler,
    riskLevel,
  });
}

/**
 * Return the risk level of a registered tool.
 *
 * @param {string} name - Registered tool name.
 * @returns {string} The tool's risk level, or `'read'` if the tool is unknown.
 */
function getRiskLevel(name) {
  return _registry.get(name)?.riskLevel ?? 'read';
}

/**
 * Return all registered tool definitions in the Anthropic API `tool_use`
 * format, ready to be passed directly to `messages.create({ tools: ... })`.
 *
 * @returns {Array<{ name: string, description: string, input_schema: object }>}
 */
function getSchemas() {
  return Array.from(_registry.entries()).map(([name, { schema }]) => ({
    name,
    description:  schema.description,
    input_schema: schema.inputSchema,
  }));
}

/**
 * Validate `input` against the tool's JSON schema and call its handler.
 *
 * Validation is performed synchronously using the pre-compiled AJV validator
 * that was stored at registration time.  If validation passes the handler is
 * awaited and its result is returned.
 *
 * @param {string} name - Registered tool name.
 * @param {object} input - Raw input object from the LLM tool_use block.
 * @returns {Promise<object>} The handler's return value.
 * @throws {Error} with `code: 'TOOL_NOT_FOUND'` if `name` is not registered.
 * @throws {Error} with `code: 'TOOL_INPUT_INVALID'` if `input` fails schema
 *   validation; the error includes a `validationErrors` array of AJV error
 *   objects.
 */
async function dispatch(name, input) {
  const tool = _registry.get(name);
  if (!tool) throw unknownToolError(name);

  const valid = tool.validate(input);
  if (!valid) throw validationError(name, tool.validate.errors);

  return tool.handler(input);
}

/**
 * Clear all registered tools.
 * **For use in tests only.**
 */
function _reset() {
  _registry.clear();
}

module.exports = { register, getSchemas, dispatch, getRiskLevel, _reset };
