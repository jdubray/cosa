'use strict';

const { searchTurns } = require('../session-store');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME       = 'archive_search';
const RISK_LEVEL = 'read';

const DEFAULT_LIMIT  = 10;
const MAX_LIMIT      = 50;
const EXCERPT_LENGTH = 200;

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
        'boolean operators (AND, OR, NOT), prefix search (word*), and ' +
        'column filters (content: prefix).',
    },
    limit: {
      type:        'integer',
      default:     DEFAULT_LIMIT,
      maximum:     MAX_LIMIT,
      minimum:     1,
      description: `Maximum number of results to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
    },
  },
  required: ['query'],
  additionalProperties: false,
};

const SCHEMA = {
  description:
    'Search across historical session turns using FTS5 full-text search. ' +
    'Useful for recalling prior incident resolutions, past operator instructions, ' +
    'or earlier tool outputs matching a keyword or phrase.  Returns ranked results ' +
    'with session context and a 200-character content excerpt.',
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
 * Search historical session turns using FTS5.
 *
 * @param {{ query: string, limit?: number }} input
 * @returns {{
 *   results:     Array<{ session_id: string, turn_index: number, role: string,
 *                        created_at: string, excerpt: string }>,
 *   total_found: number,  // count of rows returned — may be less than total matches
 * }}
 */
function handler({ query, limit = DEFAULT_LIMIT }) {
  const effectiveLimit = Math.min(limit, MAX_LIMIT);

  const rows = searchTurns(query, effectiveLimit);

  const results = rows.map(row => ({
    session_id:  row.session_id,
    turn_index:  row.turn_index,
    role:        row.role,
    created_at:  row.created_at,
    excerpt:     excerpt(row.content, EXCERPT_LENGTH),
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
