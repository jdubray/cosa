'use strict';

const { getConfig }    = require('../config/cosa.config');
const { runMigrations } = require('./session-store');
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
const pauseApplianceTool      = require('./tools/pause-appliance');

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
      const fs   = require('fs');
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
  toolRegistry.register(
    shiftReportTool.name,
    shiftReportTool.schema,
    shiftReportTool.handler,
    shiftReportTool.riskLevel
  );
  toolRegistry.register(
    archiveSearchTool.name,
    archiveSearchTool.schema,
    archiveSearchTool.handler,
    archiveSearchTool.riskLevel
  );
  toolRegistry.register(
    backupRunTool.name,
    backupRunTool.schema,
    backupRunTool.handler,
    backupRunTool.riskLevel
  );
  toolRegistry.register(
    backupVerifyTool.name,
    backupVerifyTool.schema,
    backupVerifyTool.handler,
    backupVerifyTool.riskLevel
  );
  toolRegistry.register(
    settingsWriteTool.name,
    settingsWriteTool.schema,
    settingsWriteTool.handler,
    settingsWriteTool.riskLevel
  );
  toolRegistry.register(
    restartApplianceTool.name,
    restartApplianceTool.schema,
    restartApplianceTool.handler,
    restartApplianceTool.riskLevel
  );
  toolRegistry.register(
    jwtSecretCheckTool.name,
    jwtSecretCheckTool.schema,
    jwtSecretCheckTool.handler,
    jwtSecretCheckTool.riskLevel
  );
  toolRegistry.register(
    processMonitorTool.name,
    processMonitorTool.schema,
    processMonitorTool.handler,
    processMonitorTool.riskLevel
  );
  toolRegistry.register(
    sessionSearchTool.name,
    sessionSearchTool.schema,
    sessionSearchTool.handler,
    sessionSearchTool.riskLevel
  );
  toolRegistry.register(
    cloudflareKillTool.name,
    cloudflareKillTool.schema,
    cloudflareKillTool.handler,
    cloudflareKillTool.riskLevel
  );
  toolRegistry.register(
    networkScanTool.name,
    networkScanTool.schema,
    networkScanTool.handler,
    networkScanTool.riskLevel
  );
  toolRegistry.register(
    webhookHmacVerifyTool.name,
    webhookHmacVerifyTool.schema,
    webhookHmacVerifyTool.handler,
    webhookHmacVerifyTool.riskLevel
  );
  toolRegistry.register(
    complianceVerifyTool.name,
    complianceVerifyTool.schema,
    complianceVerifyTool.handler,
    complianceVerifyTool.riskLevel
  );
  toolRegistry.register(
    pciAssessmentTool.name,
    pciAssessmentTool.schema,
    pciAssessmentTool.handler,
    pciAssessmentTool.riskLevel
  );
  toolRegistry.register(
    credentialAuditTool.name,
    credentialAuditTool.schema,
    credentialAuditTool.handler,
    credentialAuditTool.riskLevel
  );
  toolRegistry.register(
    accessLogScanTool.name,
    accessLogScanTool.schema,
    accessLogScanTool.handler,
    accessLogScanTool.riskLevel
  );
  toolRegistry.register(
    ipsAlertTool.name,
    ipsAlertTool.schema,
    ipsAlertTool.handler,
    ipsAlertTool.riskLevel
  );
  toolRegistry.register(
    tokenRotationRemindTool.name,
    tokenRotationRemindTool.schema,
    tokenRotationRemindTool.handler,
    tokenRotationRemindTool.riskLevel
  );
  toolRegistry.register(
    pauseApplianceTool.name,
    pauseApplianceTool.schema,
    pauseApplianceTool.handler,
    pauseApplianceTool.riskLevel
  );
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

if (process.argv[2] === 'credentials') {
  runCredentialsCli();
} else {
  boot();
}
