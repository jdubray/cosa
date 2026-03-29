'use strict';

const { getConfig }    = require('../config/cosa.config');
const { runMigrations } = require('./session-store');
const sshBackend       = require('./ssh-backend');
const toolRegistry     = require('./tool-registry');
const approvalEngine   = require('./approval-engine');
const emailGateway     = require('./email-gateway');
const cronScheduler    = require('./cron-scheduler');
const { runSession }   = require('./orchestrator');
const { createLogger } = require('./logger');

const log = createLogger('main');

// Tool definitions
const healthCheckTool  = require('./tools/health-check');
const dbQueryTool      = require('./tools/db-query');
const dbIntegrityTool  = require('./tools/db-integrity');

/**
 * Bootstrap COSA: load config, run migrations, test SSH connectivity,
 * register tools, and start all background services.
 * Exits with a non-zero code and descriptive message on hard failures.
 * SSH failure is a soft warning — the process continues.
 */
async function boot() {
  // 1. Load and validate config (reads .env and config/appliance.yaml).
  let config;
  try {
    config = getConfig();
  } catch (err) {
    log.error(err.message);
    process.exit(1);
  }

  const appName = config.appliance?.appliance?.name ?? 'Unknown Appliance';
  log.info(`COSA starting — target appliance: ${appName}`);

  // 2. Run database migrations (creates data/session.db if absent).
  try {
    runMigrations();
    log.info('Database migrations complete.');
  } catch (err) {
    log.error(`Database migration failed: ${err.message}`);
    process.exit(1);
  }

  // 3. Test SSH connectivity. Failure is logged as a warning; does not crash.
  await sshBackend.init();

  // 4. Register tools with the tool registry.
  toolRegistry.register(
    healthCheckTool.name,
    healthCheckTool.schema,
    healthCheckTool.handler,
    healthCheckTool.riskLevel
  );
  toolRegistry.register(
    dbQueryTool.name,
    dbQueryTool.schema,
    dbQueryTool.handler,
    dbQueryTool.riskLevel
  );
  toolRegistry.register(
    dbIntegrityTool.name,
    dbIntegrityTool.schema,
    dbIntegrityTool.handler,
    dbIntegrityTool.riskLevel
  );
  log.info(`Tools registered: ${toolRegistry.getSchemas().map(t => t.name).join(', ')}`);

  // 5. Wire email gateway to create orchestrator sessions from inbound email.
  emailGateway.setNewSessionHandler(async (message) => {
    try {
      await runSession({ type: 'email', source: 'operator', message });
    } catch (err) {
      log.error(`Email session error: ${err.message}`);
    }
  });

  // 6. Start background services.
  approvalEngine.startExpiryCheck();
  emailGateway.startPolling();
  cronScheduler.start();

  log.info('COSA ready.');
}

boot();
