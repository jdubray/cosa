'use strict';

const runbookStore     = require('../runbook-store');
const runbookExecutor  = require('../runbook-executor');
const { createLogger } = require('../logger');

const log = createLogger('runbook-trigger');

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

const NAME       = 'runbook_trigger';
const RISK_LEVEL = 'high';

const SCHEMA = {
  description:
    'Manually execute a stored runbook by name, right now. The runbook runs ' +
    'deterministically (no LLM): each step is dispatched in order and an optional ' +
    'convergence check decides success. Non-read steps run only if the runbook is ' +
    'auto_approved. Returns the outcome (success/failed/aborted), convergence, and step log.',
  inputSchema: {
    type: 'object',
    properties: {
      name:   { type: 'string', description: 'Name of the runbook to execute.' },
      reason: { type: 'string', description: 'Why the runbook is being triggered (recorded for audit).' },
    },
    required:             ['name'],
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @param {{ name: string, reason?: string }} input
 * @returns {Promise<object>}
 */
async function handler(input) {
  if (!runbookStore.get(input.name)) {
    return { success: false, error: `Runbook not found: "${input.name}"`, code: 'RUNBOOK_NOT_FOUND' };
  }

  try {
    const result = await runbookExecutor.executeRunbook(input.name, {
      source: 'manual_trigger',
      reason: input.reason ?? null,
    });
    log.info(`runbook_trigger "${input.name}" → ${result.outcome}`);
    return { success: result.outcome === 'success', ...result };
  } catch (err) {
    log.warn(`runbook_trigger failed (${input.name}): ${err.message}`);
    return { success: false, error: err.message, code: err.code ?? 'RUNBOOK_TRIGGER_FAILED' };
  }
}

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
