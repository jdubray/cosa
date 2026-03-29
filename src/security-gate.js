'use strict';

const { getConfig } = require('../config/cosa.config');

// ---------------------------------------------------------------------------
// Output sanitization patterns — hardcoded, not from appliance config
// ---------------------------------------------------------------------------

/**
 * Patterns applied by sanitizeOutput() to strip credentials from tool output
 * before it is written to the LLM conversation history.
 *
 * Each entry replaces matching text with the literal string `[REDACTED]`.
 *
 * @type {Array<{ label: string, pattern: RegExp }>}
 */
const SANITIZE_PATTERNS = [
  // Anthropic API keys  (sk-ant-api03-...)
  { label: 'Anthropic API key', pattern: /sk-ant-[A-Za-z0-9\-_]+/g },
  // password=<value>
  { label: 'password',          pattern: /password\s*=\s*\S+/gi },
  // token=<value>
  { label: 'token',             pattern: /token\s*=\s*\S+/gi },
  // secret=<value>  (generic credential key)
  { label: 'secret',            pattern: /secret\s*=\s*\S+/gi },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check a tool call against every dangerous-command pattern defined in
 * `config/appliance.yaml` under `security.dangerous_commands`.
 *
 * The entire tool input is JSON-serialised before matching so that patterns
 * embedded in nested fields are also caught.  Pattern matching is
 * case-insensitive.
 *
 * @param {{ tool_name: string, input: object }} toolCall
 * @returns {{ blocked: false }
 *          | { blocked: true, reason: string, pattern: string }}
 */
function check(toolCall) {
  const { appliance } = getConfig();
  const dangerousCommands = appliance.security?.dangerous_commands ?? [];

  const subject = JSON.stringify(toolCall.input);

  for (const entry of dangerousCommands) {
    const regex = new RegExp(entry.pattern, 'i');
    if (regex.test(subject)) {
      return { blocked: true, reason: entry.reason, pattern: entry.pattern };
    }
  }

  return { blocked: false };
}

/**
 * Remove known sensitive values from tool output before it enters the LLM
 * conversation context.
 *
 * Accepts strings or any JSON-serialisable value.  Always returns a string.
 *
 * @param {string | object} output - Tool output (string or JSON-serialisable).
 * @returns {string} Output with sensitive values replaced by `[REDACTED]`.
 */
function sanitizeOutput(output) {
  const str = typeof output === 'string' ? output : JSON.stringify(output);

  return SANITIZE_PATTERNS.reduce(
    (acc, { pattern }) => acc.replace(pattern, '[REDACTED]'),
    str
  );
}

module.exports = { check, sanitizeOutput };
