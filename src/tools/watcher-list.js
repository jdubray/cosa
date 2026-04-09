'use strict';

const watcherRegistry = require('../watcher-registry');

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

const NAME       = 'watcher_list';
const RISK_LEVEL = 'read';

const SCHEMA = {
  description:
    'List all registered monitoring conditions (watchers), including disabled ones. ' +
    'Use to answer operator questions like "what are you watching for?" or ' +
    'to check if a watcher already exists before registering a new one. ' +
    'Pass show_code:true to include the JavaScript predicate in each entry — ' +
    'use this when the operator asks to inspect or audit watcher code.',
  inputSchema: {
    type: 'object',
    properties: {
      show_code: {
        type:        'boolean',
        description: 'If true, include the JavaScript predicate code in each watcher entry.',
      },
    },
    required:             [],
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @param {{ show_code?: boolean }} input
 * @returns {Promise<object>}
 */
async function handler(input) {
  const rows = await watcherRegistry.list();
  return {
    success:  true,
    count:    rows.length,
    watchers: rows.map(w => ({
      id:                w.id,
      name:              w.name,
      description:       w.description,
      ...(input.show_code ? { code: w.code } : {}),
      enabled:           w.enabled === 1,
      trigger_count:     w.trigger_count,
      last_triggered_at: w.last_triggered_at ?? null,
      last_alerted_at:   w.last_alerted_at   ?? null,
      created_at:        w.created_at,
    })),
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
