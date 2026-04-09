'use strict';

const watcherRegistry  = require('../watcher-registry');
const { createLogger } = require('../logger');

const log = createLogger('watcher-remove');

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

const NAME       = 'watcher_remove';
const RISK_LEVEL = 'medium'; // permanently removes a monitoring condition

const SCHEMA = {
  description:
    'Permanently delete a watcher by id. ' +
    'Use when the operator asks to stop watching a specific condition entirely. ' +
    'To temporarily pause a watcher without deleting it, use watcher_set_enabled instead.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type:        'string',
        description: 'The watcher id to permanently delete, e.g. "printer_fault".',
      },
    },
    required:             ['id'],
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @param {{ id: string }} input
 * @returns {Promise<object>}
 */
async function handler(input) {
  try {
    await watcherRegistry.remove(input.id);
    log.info(`Watcher removed: ${input.id}`);
    return {
      success: true,
      id:      input.id,
      message: `Watcher "${input.id}" has been permanently deleted.`,
    };
  } catch (err) {
    log.warn(`Watcher removal failed (${input.id}): ${err.message}`);
    return {
      success: false,
      error:   err.message,
      code:    err.code ?? 'WATCHER_REMOVE_FAILED',
    };
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
