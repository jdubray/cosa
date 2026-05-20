'use strict';

const runbookStore = require('../runbook-store');

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

const NAME       = 'runbook_list';
const RISK_LEVEL = 'read';

const SCHEMA = {
  description:
    'List stored runbooks (named, deterministic tool-call sequences that run in ' +
    'response to a watcher firing). Returns summary metadata only — name, ' +
    'description, version, whether the runbook is auto-approved, and last update. ' +
    'Use to check whether a runbook already exists before authoring one.',
  inputSchema: {
    type:                 'object',
    properties:           {},
    required:             [],
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<object>}
 */
async function handler() {
  const rows = runbookStore.list();
  return {
    success: true,
    count:   rows.length,
    runbooks: rows.map(r => ({
      name:          r.name,
      description:   r.description,
      version:       r.version,
      auto_approved: r.auto_approved === 1,
      updated_at:    r.updated_at,
    })),
  };
}

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
