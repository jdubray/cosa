'use strict';

const fs           = require('fs');
const path         = require('path');
const toolRegistry = require('./tool-registry');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Delimiter used to separate sections in the assembled system prompt. */
const DELIMITER = '\n---\n';

/** Path to the appliance identity document. */
const APPLIANCE_MD_PATH = path.join(__dirname, '../config/APPLIANCE.md');

/** Appliance context document — cached at module load; does not change at runtime. */
const APPLIANCE_MD = fs.readFileSync(APPLIANCE_MD_PATH, 'utf8');

/**
 * §12.2 COSA identity block (verbatim).
 *
 * Defines COSA's role, responsibilities, operating principles, and
 * communication style.  This text is the Layer 0 of every system prompt.
 */
const COSA_IDENTITY = [
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a single tool schema entry for inclusion in the system prompt.
 *
 * @param {{ name: string, description: string, input_schema: object }} tool
 * @returns {string}
 */
function formatTool(tool) {
  return [
    `Tool: ${tool.name}`,
    `Description: ${tool.description}`,
    `Input schema: ${JSON.stringify(tool.input_schema)}`,
  ].join('\n');
}

/**
 * Build the tools section from the currently registered (enabled) tools.
 *
 * @returns {string}
 */
function buildToolsSection() {
  const schemas = toolRegistry.getSchemas();
  if (schemas.length === 0) {
    return 'Available tools: (none)';
  }
  return `Available tools:\n\n${schemas.map(formatTool).join('\n\n')}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assemble the layered system prompt for a COSA session.
 *
 * The prompt is composed of four sections, separated by `---`:
 *   1. COSA identity  (§12.2 verbatim)
 *   2. Appliance context  (config/APPLIANCE.md)
 *   3. Available tools  (enabled tools from the registry)
 *   4. Current ISO timestamp
 *
 * @returns {string} The fully assembled system prompt string.
 */
function build() {
  const toolsSection = buildToolsSection();
  const timestamp    = `Current time: ${new Date().toISOString()}`;

  return [
    COSA_IDENTITY,
    APPLIANCE_MD.trimEnd(),
    toolsSection,
    timestamp,
  ].join(DELIMITER);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { build };
