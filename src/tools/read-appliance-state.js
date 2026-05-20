'use strict';

const applianceStateMachine = require('../appliance-state-machine');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME       = 'read_appliance_state';
const RISK_LEVEL = 'read';

const INPUT_SCHEMA = {
  type:                 'object',
  properties:           {},
  required:             [],
  additionalProperties: false,
};

const SCHEMA = {
  description:
    'Return the current cached appliance state snapshot without running any live probes. ' +
    'Shows the last known values for all five monitoring dimensions (health, resources, ' +
    'application, network, security) and their staleness age. ' +
    'Use this for a quick status overview when the data is recent enough. ' +
    'Call health_check or resource_threshold_monitor instead if a dimension is marked ' +
    'stale and you need guaranteed-fresh readings.',
  inputSchema: INPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Return the in-memory appliance state snapshot.
 *
 * @returns {object}
 */
async function handler() {
  const snapshot = applianceStateMachine.getSnapshot();
  if (!snapshot) {
    return {
      status:  'uninitialized',
      message: 'No appliance state data yet. The monitoring cron has not run since startup.',
    };
  }
  return snapshot;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
