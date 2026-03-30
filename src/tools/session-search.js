'use strict';

const { searchTurnsWithSession } = require('../session-store');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME       = 'session_search';
const RISK_LEVEL = 'read';

const DEFAULT_LIMIT  = 10;
const MAX_LIMIT      = 50;
const EXCERPT_LENGTH = 200;

const VALID_ROLES = ['user', 'assistant', 'tool'];

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    query: {
      type:        'string',
      description:
        'FTS5 search query.  Supports phrase matching ("exact phrase"), ' +
        'boolean operators (AND, OR, NOT), and prefix search (word*).',
    },
    limit: {
      type:        'integer',
      default:     DEFAULT_LIMIT,
      maximum:     MAX_LIMIT,
      minimum:     1,
      description: `Maximum number of results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
    },
    role: {
      type:        'string',
      enum:        VALID_ROLES,
      description:
        "Optional role filter.  One of 'user', 'assistant', or 'tool'. " +
        'When omitted all roles are included.',
    },
  },
  required: ['query'],
  additionalProperties: false,
};

const SCHEMA = {
  description:
    'Search prior session turns using FTS5 full-text search, enriched with ' +
    'session metadata (started_at, trigger_type).  Useful for recalling prior ' +
    'incident resolutions, operator instructions, or tool outputs. ' +
    'Supports an optional role filter to narrow results to user messages, ' +
    'assistant responses, or tool outputs.',
  inputSchema: INPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Truncate `text` to at most `maxLen` characters, appending "…" when cut.
 *
 * @param {string|null} text
 * @param {number} maxLen
 * @returns {string}
 */
function excerpt(text, maxLen) {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

/**
 * Search session turns by keyword with optional role filter.
 *
 * @param {{ query: string, limit?: number, role?: string }} input
 * @returns {{
 *   results:     Array<{
 *     session_id:   string,
 *     started_at:   string,
 *     trigger_type: string,
 *     turn_index:   number,
 *     role:         string,
 *     excerpt:      string,
 *     created_at:   string,
 *   }>,
 *   total_found: number,  // count of rows returned — may be less than total matches
 * }}
 */
function handler({ query, limit = DEFAULT_LIMIT, role }) {
  const effectiveLimit = Math.min(limit, MAX_LIMIT);
  const roleFilter     = role ?? null;

  const rows = searchTurnsWithSession(query, effectiveLimit, roleFilter);

  const results = rows.map(row => ({
    session_id:   row.session_id,
    started_at:   row.started_at,
    trigger_type: row.trigger_type,
    turn_index:   row.turn_index,
    role:         row.role,
    excerpt:      excerpt(row.content, EXCERPT_LENGTH),
    created_at:   row.created_at,
  }));

  return {
    results,
    total_found: results.length,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
