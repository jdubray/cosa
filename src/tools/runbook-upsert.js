'use strict';

const runbookStore     = require('../runbook-store');
const { createLogger } = require('../logger');

const log = createLogger('runbook-upsert');

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

const NAME       = 'runbook_upsert';
const RISK_LEVEL = 'medium';

const STEP_SCHEMA = {
  type: 'object',
  properties: {
    tool_name:   { type: 'string', description: 'Registered tool name to dispatch.' },
    input:       { type: 'object', description: 'Static tool input (no runtime interpolation).' },
    description: { type: 'string', description: 'Human-readable label for logs.' },
  },
  required:             ['tool_name'],
  additionalProperties: false,
};

const SCHEMA = {
  description:
    'Create or update a runbook — a named, deterministic sequence of tool calls that ' +
    'runs (without an LLM) when a watcher fires. Steps dispatch registered tools with ' +
    'static inputs. An optional convergence check decides success and is re-run up to ' +
    'max_iterations times. IMPORTANT: a runbook containing any non-read step will be ' +
    'refused at execution time unless auto_approved is true — set auto_approved only ' +
    'when the operator has explicitly pre-authorised those actions.',
  inputSchema: {
    type: 'object',
    properties: {
      name:        { type: 'string', description: 'Unique runbook name, /^[a-z0-9_]{1,64}$/.' },
      description: { type: 'string', description: 'What the runbook does and when it should run.' },
      steps: {
        type:        'array',
        minItems:    1,
        items:       STEP_SCHEMA,
        description: 'Ordered tool-call steps.',
      },
      convergence: {
        type: 'object',
        properties: {
          tool_name:    { type: 'string' },
          input:        { type: 'object' },
          check_field:  { type: 'string', description: 'Dot-path into the result, e.g. "overall_status".' },
          expect_value: {},
        },
        required:             ['tool_name', 'check_field'],
        additionalProperties: false,
        description: 'Optional post-step verification that the desired state was reached.',
      },
      max_iterations: { type: 'integer', minimum: 1, maximum: 10, description: 'Convergence retry cap (default 3).' },
      on_failure:     { type: 'string', enum: ['alert', 'abort'], description: 'Behaviour when a step throws (default alert).' },
      auto_approved:  { type: 'boolean', description: 'If true, non-read steps may run deterministically (default false).' },
    },
    required:             ['name', 'description', 'steps'],
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @param {object} input
 * @returns {Promise<object>}
 */
async function handler(input) {
  try {
    const { name, version } = runbookStore.upsert({
      name:          input.name,
      description:   input.description,
      steps:         input.steps,
      convergence:   input.convergence ?? null,
      maxIterations: input.max_iterations,
      onFailure:     input.on_failure,
      autoApproved:  input.auto_approved,
    });
    return { success: true, name, version };
  } catch (err) {
    log.warn(`runbook_upsert failed (${input.name}): ${err.message}`);
    return { success: false, error: err.message, code: err.code ?? 'RUNBOOK_UPSERT_FAILED' };
  }
}

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
