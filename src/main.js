'use strict';

const { getConfig }    = require('../config/cosa.config');
const { runMigrations, closeDb: closeSessionDb } = require('./session-store');
const skillStore       = require('./skill-store');
const sshBackend       = require('./ssh-backend');
const toolRegistry     = require('./tool-registry');
const approvalEngine   = require('./approval-engine');
const emailGateway     = require('./email-gateway');
const cronScheduler    = require('./cron-scheduler');
const { runSession }   = require('./orchestrator');
const { createLogger } = require('./logger');
const { startCli }     = require('./cli');
const credentialStore  = require('./credential-store');
const securityGate     = require('./security-gate');

const log = createLogger('main');

// Tool definitions
const healthCheckTool  = require('./tools/health-check');
const dbQueryTool      = require('./tools/db-query');
const dbIntegrityTool  = require('./tools/db-integrity');
const shiftReportTool  = require('./tools/shift-report');
const archiveSearchTool = require('./tools/archive-search');
const backupRunTool     = require('./tools/backup-run');
const backupVerifyTool  = require('./tools/backup-verify');
const settingsWriteTool     = require('./tools/settings-write');
const restartApplianceTool  = require('./tools/restart-appliance');
const sessionSearchTool     = require('./tools/session-search');
const jwtSecretCheckTool    = require('./tools/jwt-secret-check');
const processMonitorTool    = require('./tools/process-monitor');
const cloudflareKillTool    = require('./tools/cloudflare-kill');
const networkScanTool       = require('./tools/network-scan');
const webhookHmacVerifyTool  = require('./tools/webhook-hmac-verify');
const complianceVerifyTool   = require('./tools/compliance-verify');
const pciAssessmentTool      = require('./tools/pci-assessment');
const credentialAuditTool    = require('./tools/credential-audit');
const accessLogScanTool      = require('./tools/access-log-scan');
const ipsAlertTool           = require('./tools/ips-alert');
const tokenRotationRemindTool = require('./tools/token-rotation-remind');
const pauseApplianceTool         = require('./tools/pause-appliance');
const applianceStatusPollTool    = require('./tools/appliance-status-poll');
const applianceApiCallTool       = require('./tools/appliance-api-call');
const watcherRegisterTool        = require('./tools/watcher-register');
const watcherListTool            = require('./tools/watcher-list');
const watcherRemoveTool          = require('./tools/watcher-remove');
const watcherSetEnabledTool      = require('./tools/watcher-set-enabled');
const internetIpCheckTool        = require('./tools/internet-ip-check');

// ---------------------------------------------------------------------------
// Credential store CLI subcommand
// Invoked when process.argv[2] === 'credentials'.
// Usage:
//   node src/main.js credentials set <name> <value>
//   node src/main.js credentials list
//   node src/main.js credentials import <file.json>
// ---------------------------------------------------------------------------

function runCredentialsCli() {
  const sub  = process.argv[3];
  const args = process.argv.slice(4);

  try {
    if (sub === 'set') {
      const [name, value] = args;
      if (!name || !value) {
        process.stderr.write('Usage: credentials set <name> <value>\n');
        process.exit(1);
      }
      credentialStore.set(name, value);
      process.stdout.write(`Stored: ${name}\n`);

    } else if (sub === 'list') {
      const rows = credentialStore.list();
      if (rows.length === 0) {
        process.stdout.write('No credentials stored.\n');
      } else {
        for (const row of rows) {
          const accessed = row.last_accessed
            ? new Date(row.last_accessed).toISOString()
            : 'never';
          process.stdout.write(
            `${row.name}  created=${new Date(row.created_at).toISOString()}  last_accessed=${accessed}\n`
          );
        }
      }

    } else if (sub === 'import') {
      const [filePath] = args;
      if (!filePath) {
        process.stderr.write('Usage: credentials import <file.json>\n');
        process.exit(1);
      }
      const fs    = require('fs');
      const MAX_IMPORT_BYTES = 1 * 1024 * 1024; // 1 MiB
      const { size } = fs.statSync(filePath);
      if (size > MAX_IMPORT_BYTES) {
        process.stderr.write(`Import file too large (${size} bytes; max ${MAX_IMPORT_BYTES}).\n`);
        process.exit(1);
      }
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (typeof data !== 'object' || Array.isArray(data)) {
        process.stderr.write('Import file must be a JSON object mapping names to values.\n');
        process.exit(1);
      }
      for (const [name, value] of Object.entries(data)) {
        credentialStore.set(name, String(value));
      }
      process.stdout.write(`Imported ${Object.keys(data).length} credential(s).\n`);

    } else {
      process.stderr.write(
        'Usage:\n' +
        '  credentials set <name> <value>\n' +
        '  credentials list\n' +
        '  credentials import <file.json>\n'
      );
      process.exit(1);
    }
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }

  process.exit(0);
}

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

  // 2b. Run skills.db migrations and install seed skills on first run.
  try {
    skillStore.runMigrations();
    const { installed } = skillStore.installSeedSkills();
    if (installed.length > 0) {
      log.info(`Seed skills installed: ${installed.join(', ')}`);
    }
  } catch (err) {
    log.error(`Skills setup failed: ${err.message}`);
    process.exit(1);
  }

  // 2c. Validate credential store — fails fast if COSA_CREDENTIAL_KEY is absent.
  try {
    credentialStore.validateOnStartup();
  } catch (err) {
    log.error(`Credential store initialisation failed: ${err.message}`);
    process.exit(1);
  }

  // 3. Test SSH connectivity. Failure is logged as a warning; does not crash.
  await sshBackend.init();

  // 3b. Initialise Tirith pre-execution scanner (optional). If the binary is
  //     absent a warning is logged and COSA falls back to dangerous-cmd only.
  securityGate.initTirith();

  // 4. Register tools with the tool registry.
  for (const t of [
    healthCheckTool, dbQueryTool, dbIntegrityTool, shiftReportTool,
    archiveSearchTool, backupRunTool, backupVerifyTool, settingsWriteTool,
    restartApplianceTool, sessionSearchTool, jwtSecretCheckTool, processMonitorTool,
    cloudflareKillTool, networkScanTool, webhookHmacVerifyTool, complianceVerifyTool,
    pciAssessmentTool, credentialAuditTool, accessLogScanTool, ipsAlertTool,
    tokenRotationRemindTool, pauseApplianceTool,
    applianceStatusPollTool, applianceApiCallTool,
    watcherRegisterTool, watcherListTool, watcherRemoveTool, watcherSetEnabledTool,
    internetIpCheckTool,
  ]) {
    toolRegistry.register(t.name, t.schema, t.handler, t.riskLevel);
  }
  log.info(`Tools registered: ${toolRegistry.getSchemas().map(t => t.name).join(', ')}`);

  // In CLI mode skip email polling and cron — use interactive REPL instead.
  if (process.argv.includes('--cli')) {
    log.info('COSA CLI ready.');
    startCli();
    return;
  }

  // 5. Wire email gateway to create orchestrator sessions from inbound email.
  emailGateway.setNewSessionHandler(async (message) => {
    // Build a readable string for the agent from the email envelope.
    // saveTurn / Anthropic messages.create both require content to be a string.
    const emailParts = [];
    if (message.subject) emailParts.push(message.subject);
    emailParts.push(message.body || '(empty message)');
    const emailContent = emailParts.join('\n\n');

    const messageText =
      `The operator has sent you the following email. ` +
      `Read the entire message and execute every requested action before replying.\n\n` +
      `---\n${emailContent}\n---`;

    try {
      const { response } = await runSession({
        type:    'email',
        source:  message.from,
        message: messageText,
      });

      await emailGateway.sendEmail({
        to:         message.from,
        subject:    message.subject ? `Re: ${message.subject}` : 'COSA',
        text:       response,
        inReplyTo:  message.messageId ?? undefined,
        references: message.messageId ?? undefined,
      });
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

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

/**
 * Stop all background services and flush/close every database before exit.
 * Called on SIGINT, SIGTERM, and the process 'exit' event.
 *
 * @param {string} signal
 */
function _shutdown(signal) {
  log.info(`Received ${signal} — shutting down gracefully`);
  try { cronScheduler.stop(); }           catch { /* ignore */ }
  try { emailGateway.stopPolling(); }     catch { /* ignore */ }
  try { approvalEngine.stopExpiryCheck(); } catch { /* ignore */ }
  try { skillStore.closeDb(); }           catch { /* ignore */ }
  try { credentialStore.closeDb(); }      catch { /* ignore */ }
  try { closeSessionDb(); }               catch { /* ignore */ }
  process.exit(0);
}

process.on('SIGINT',  () => _shutdown('SIGINT'));
process.on('SIGTERM', () => _shutdown('SIGTERM'));

if (process.argv[2] === 'credentials') {
  runCredentialsCli();
} else {
  boot();
}
