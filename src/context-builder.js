'use strict';

const fs           = require('fs');
const path         = require('path');
const toolRegistry = require('./tool-registry');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Delimiter separating layers within the cached system block. */
const DELIMITER = '\n---\n';

/** Layer 1 — Appliance identity document (cached at module load). */
const APPLIANCE_MD_PATH = path.join(__dirname, '../config/APPLIANCE.md');
const APPLIANCE_MD = fs.readFileSync(APPLIANCE_MD_PATH, 'utf8');

/** Layer 2 — Operational patterns document (optional; absent on first deploy). */
const OPERATIONS_MD_PATH = path.join(__dirname, '../config/OPERATIONS.md');
const OPERATIONS_MD = fs.existsSync(OPERATIONS_MD_PATH)
  ? fs.readFileSync(OPERATIONS_MD_PATH, 'utf8')
  : null;

/**
 * Layer 0 — COSA core identity (§12.2 verbatim).
 *
 * Static across all appliances.  Forms the base of every system prompt.
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
// Layer helpers
// ---------------------------------------------------------------------------

/**
 * Format a single tool schema entry for Layer 6.
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
 * Build the tool registry section (Layer 6) from currently registered tools.
 *
 * @returns {string}
 */
function buildToolsSection() {
  const schemas = toolRegistry.getSchemas();
  if (schemas.length === 0) return 'Available tools: (none)';
  return `Available tools:\n\n${schemas.map(formatTool).join('\n\n')}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assemble the 10-layer system prompt for a COSA session and return it as an
 * array of Anthropic system blocks.
 *
 * **Layer assignments:**
 * | Layer | Content | Cache? |
 * |-------|---------|--------|
 * | 0 | COSA core identity | ✓ (part of cached block) |
 * | 1 | `config/APPLIANCE.md` | ✓ |
 * | 2 | `config/OPERATIONS.md` (omitted if file absent) | ✓ |
 * | 3 | Skill index — compact list (~30 tokens/skill) | ✓ (omitted if not provided) |
 * | 4 | `MEMORY.md` snapshot | ✓ (omitted if not provided) |
 * | 5 | Active skill documents — full text | ✗ |
 * | 6 | Tool registry schemas | ✗ |
 * | 7 | Session context summary (compressed turns) | ✗ (omitted if not provided) |
 * | 8 | Cross-session recall — not yet implemented | — |
 * | 9 | Current ISO timestamp | ✗ |
 *
 * Layers 0–4 are concatenated into **one** block marked
 * `cache_control: { type: 'ephemeral' }`.  Layers 5–9 are returned as
 * separate blocks without cache hints so they can vary per turn.
 *
 * The returned array is suitable for direct use as the `system` parameter
 * of `client.messages.create()`.
 *
 * @param {{
 *   memory?:         string,    // Layer 4 — MEMORY.md contents
 *   skillIndex?:     string,    // Layer 3 — compact skill list
 *   activeSkills?:   string[],  // Layer 5 — full skill documents
 *   sessionSummary?: string,    // Layer 7 — compressed context summary
 * }} [options={}]
 * @returns {Array<{ type: 'text', text: string, cache_control?: { type: 'ephemeral' } }>}
 */
function build(options = {}) {
  const { memory, skillIndex, activeSkills, sessionSummary } = options;

  // ── Cached block: Layers 0–4 ──────────────────────────────────────────────
  const cachedParts = [
    COSA_IDENTITY,                 // Layer 0
    APPLIANCE_MD.trimEnd(),        // Layer 1
  ];

  if (OPERATIONS_MD !== null) {
    cachedParts.push(OPERATIONS_MD.trimEnd());  // Layer 2
  }

  if (skillIndex != null) {
    cachedParts.push(`## Skill Index\n\n${skillIndex}`);  // Layer 3
  }

  if (memory != null) {
    cachedParts.push(memory.trimEnd());  // Layer 4
  }

  const blocks = [
    {
      type:          'text',
      text:          cachedParts.join(DELIMITER),
      cache_control: { type: 'ephemeral' },
    },
  ];

  // ── Fresh blocks: Layers 5–9 ──────────────────────────────────────────────

  // Layer 5 — Active skill documents.
  if (Array.isArray(activeSkills) && activeSkills.length > 0) {
    blocks.push({
      type: 'text',
      text: `## Active Skills\n\n${activeSkills.join('\n\n---\n\n')}`,
    });
  }

  // Layer 6 — Tool registry.
  blocks.push({
    type: 'text',
    text: buildToolsSection(),
  });

  // Layer 7 — Session context summary (compressed middle turns).
  if (sessionSummary != null) {
    blocks.push({
      type: 'text',
      text: `## Session Summary\n\n${sessionSummary}`,
    });
  }

  // Layer 8 — Cross-session recall: deferred to Phase 3.

  // Layer 9 — Current timestamp.
  blocks.push({
    type: 'text',
    text: `Current time: ${new Date().toISOString()}`,
  });

  return blocks;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { build };
