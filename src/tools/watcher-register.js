'use strict';

const watcherRegistry  = require('../watcher-registry');
const { createLogger } = require('../logger');

const log = createLogger('watcher-register');

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

const NAME       = 'watcher_register';
const RISK_LEVEL = 'medium'; // installs code that runs on every cron poll cycle

const SCHEMA = {
  description:
    'Register a new monitoring condition (watcher) or replace an existing one. ' +
    'Always call appliance_status_poll first with skip_watchers:true to inspect ' +
    'the live status snapshot structure before writing the predicate. ' +
    'The watcher function receives the full status object and must return ' +
    '{ triggered: boolean, message?: string }. ' +
    'It runs automatically on every subsequent appliance_status_poll.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type:        'string',
        description: 'Unique snake_case identifier, e.g. "printer_fault" or "high_pending_orders". ' +
                     'Reusing an existing id replaces that watcher.',
      },
      name: {
        type:        'string',
        description: 'Short human-readable label shown in alert emails, e.g. "Printer fault or absent".',
      },
      description: {
        type:        'string',
        description: 'The original operator request in natural language. Preserved as an audit trail.',
      },
      code: {
        type:        'string',
        description:
          'Complete JavaScript function that receives `status` (the appliance snapshot) and returns ' +
          '{ triggered: boolean, message?: string }. ' +
          'IMPORTANT: many fields in the snapshot may be null — always use optional chaining (?.) ' +
          'and nullish coalescing (??) to avoid TypeError. Never compare null values with > or < directly. ' +
          'Fields that are commonly null: terminals[].checked_at (non-PAX D135 models), ' +
          'printers[].checked_at (first ~120 s after appliance restart), ' +
          'orders.oldest_active_minutes (no active orders), ' +
          'payments.last_successful_at (no payments recorded yet), ' +
          'store.next_open_label (store is currently open), ' +
          'errors.recent[].route and .stack (not yet populated — always null). ' +
          'Do not alert on security.anomalous_req_rate unless system.uptime_s > 10800 (3 hours); ' +
          'the field is always false on a freshly restarted appliance until enough baseline samples exist. ' +
          'Treat hardware.printers[].status === "unknown" as non-alerting (probe not yet run); ' +
          'alert only on "timeout" or "refused". ' +
          'Example: function watch(status) { ' +
          '  const pending = status?.orders?.pending ?? 0; ' +
          '  if (pending > 5) return { triggered: true, message: pending + " orders pending" }; ' +
          '  return { triggered: false }; ' +
          '}',
      },
    },
    required: ['id', 'name', 'description', 'code'],
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @param {{ id: string, name: string, description: string, code: string }} input
 * @returns {Promise<object>}
 */
async function handler(input) {
  try {
    await watcherRegistry.register({
      id:          input.id,
      name:        input.name,
      description: input.description,
      code:        input.code,
    });
    log.info(`Watcher registered: ${input.id} — "${input.name}"`);
    return {
      success: true,
      id:      input.id,
      name:    input.name,
      message: `Watcher "${input.name}" registered. It will evaluate on every appliance_status_poll.`,
    };
  } catch (err) {
    log.warn(`Watcher registration failed (${input.id}): ${err.message}`);
    return {
      success: false,
      error:   err.message,
      code:    err.code ?? 'WATCHER_REGISTER_FAILED',
    };
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
