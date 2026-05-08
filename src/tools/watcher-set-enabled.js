'use strict';

const watcherRegistry  = require('../watcher-registry');
const { createLogger } = require('../logger');

const log = createLogger('watcher-set-enabled');

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

const NAME       = 'watcher_set_enabled';
const RISK_LEVEL = 'medium';

const SCHEMA = {
  description:
    'Enable or disable a watcher without deleting it. ' +
    'Use to temporarily pause monitoring for a condition (e.g. during maintenance) ' +
    'without losing the watcher definition. Re-enable it later with enabled:true.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type:        'string',
        description: 'The watcher id to enable or disable, e.g. "printer_fault".',
      },
      enabled: {
        type:        'boolean',
        description: 'true to enable the watcher, false to disable it.',
      },
    },
    required:             ['id', 'enabled'],
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @param {{ id: string, enabled: boolean }} input
 * @returns {Promise<object>}
 */
async function handler(input) {
  try {
    await watcherRegistry.setEnabled(input.id, input.enabled);
    const verb = input.enabled ? 'enabled' : 'disabled';
    log.info(`Watcher ${verb}: ${input.id}`);
    return {
      success: true,
      id:      input.id,
      enabled: input.enabled,
      message: `Watcher "${input.id}" has been ${verb}.`,
    };
  } catch (err) {
    log.warn(`watcher_set_enabled failed (${input.id}): ${err.message}`);
    return {
      success: false,
      error:   err.message,
      code:    err.code ?? 'WATCHER_SET_ENABLED_FAILED',
    };
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
