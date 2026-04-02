'use strict';

const sshBackend    = require('../ssh-backend');
const toolRegistry  = require('../tool-registry');
const { createLogger } = require('../logger');

const log = createLogger('cloudflare-kill');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME       = 'cloudflare_kill';
const RISK_LEVEL = 'high';

// Static commands — never constructed from user input.
const CMD_SYSTEMCTL = 'systemctl stop cloudflared';
const CMD_PM2       = 'pm2 stop cloudflared';
const CMD_PGREP     = 'pgrep cloudflared';
const CMD_KILL      = 'kill $(pgrep cloudflared)';

const INPUT_SCHEMA = {
  type:                 'object',
  properties:           {},
  required:             [],
  additionalProperties: false,
};

const SCHEMA = {
  description:
    'Immediately kill the Cloudflare tunnel daemon (cloudflared) on the ' +
    'Baanbaan appliance via SSH. Attempts a graceful systemctl stop first, ' +
    'falls back to pm2 stop, then to a direct kill via pgrep/kill. ' +
    'Waits 2 s and verifies the process is no longer running. ' +
    'On success, fires an ips_alert event (fire-and-forget). ' +
    'Returns success, the method used, a verification flag, and a timestamp.',
  inputSchema: INPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{
 *   success: boolean,
 *   method: string | null,
 *   verificationPass: boolean,
 *   error: string | null,
 *   timestamp: string
 * }>}
 */
async function handler() {
  const timestamp = new Date().toISOString();

  if (!sshBackend.isConnected()) {
    throw new Error('SSH not connected — cannot kill cloudflared');
  }

  let method = null;

  // ── Step 1: systemctl stop ────────────────────────────────────────────────
  log.info('Attempting systemctl stop cloudflared');
  const systemctlResult = await sshBackend.exec(CMD_SYSTEMCTL);
  if (systemctlResult.exitCode === 0) {
    method = 'systemctl';
    log.info('systemctl stop cloudflared succeeded');
  }

  // ── Step 2: pm2 stop (if systemctl did not succeed) ──────────────────────
  if (method === null) {
    log.info('systemctl failed, attempting pm2 stop cloudflared');
    const pm2Result = await sshBackend.exec(CMD_PM2);
    if (pm2Result.exitCode === 0) {
      method = 'pm2';
      log.info('pm2 stop cloudflared succeeded');
    }
  }

  // ── Step 3: pgrep/kill fallback ───────────────────────────────────────────
  if (method === null) {
    log.info('pm2 failed, attempting kill via pgrep cloudflared');
    const killResult = await sshBackend.exec(CMD_KILL);
    if (killResult.exitCode === 0) {
      method = 'kill';
      log.info('kill $(pgrep cloudflared) succeeded');
    }
  }

  if (method === null) {
    log.warn('All kill methods failed for cloudflared');
    return {
      success:          false,
      method:           null,
      verificationPass: false,
      error:            'All kill attempts failed (systemctl, pm2, kill)',
      timestamp,
    };
  }

  // ── Step 4: 2-second pause then verify ───────────────────────────────────
  await sleep(2000);

  const pgrepResult = await sshBackend.exec(CMD_PGREP);
  // pgrep exits non-zero when no process matches — that means the process is gone.
  const verificationPass = pgrepResult.exitCode !== 0;

  log.info(
    `cloudflare-kill verification: pgrep exit=${pgrepResult.exitCode}, ` +
    `verificationPass=${verificationPass}`
  );

  const success = verificationPass;

  // ── Step 5: Fire-and-forget ips_alert on success ──────────────────────────
  if (success) {
    const alertPayload = {
      alert_type: 'cloudflared_killed',
      severity:   'high',
      message:    `Cloudflare tunnel daemon killed via ${method} at ${timestamp}`,
    };
    // Deliberately not awaited — the kill result must not depend on alert delivery.
    toolRegistry.dispatch('ips_alert', alertPayload).catch((err) => {
      // TOOL_NOT_FOUND is expected if ips_alert is not yet registered.
      if (err.code !== 'TOOL_NOT_FOUND') {
        log.warn(`ips_alert dispatch error: ${err.message}`);
      }
    });
  }

  return {
    success,
    method,
    verificationPass,
    error:     success ? null : 'Process still running after kill attempt',
    timestamp,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
