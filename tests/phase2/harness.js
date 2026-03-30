'use strict';

/**
 * Shared fixtures and helpers for the COSA Phase 2 staging test suite (T-2.x).
 *
 * Extends the Phase 1 harness patterns with:
 *   - WeatherStation appliance config (used in Phase 2)
 *   - Tool-use response builders for backup, shift_report, session_search
 *   - Phase 2 cron config defaults
 */

const os   = require('os');
const path = require('path');
const fs   = require('fs');

// ---------------------------------------------------------------------------
// Config factory
// ---------------------------------------------------------------------------

/**
 * Build a synthetic COSA config for Phase 2 staging tests.
 *
 * @param {string} dataDir - Absolute path to a writable temp directory.
 * @returns {{ env: object, appliance: object }}
 */
function makeStagingConfig(dataDir) {
  return {
    env: {
      anthropicApiKey: 'sk-ant-phase2-test-key',
      email: {
        address:     'cosa@test.local',
        imapHost:    'imap.test.local',
        imapPort:    993,
        smtpHost:    'smtp.test.local',
        smtpPort:    587,
        username:    'cosa@test.local',
        appPassword: 'staging-test-password',
      },
      dataDir,
      logLevel: 'error',
      nodeEnv:  'staging',
    },
    appliance: {
      name: 'WeatherStation (Staging)',
      appliance_api: {
        base_url:              'http://192.168.1.20:8080',
        health_endpoint:       '/health',
        health_ready_endpoint: '/health/ready',
        request_timeout_ms:    2000,
      },
      ssh: {
        host:               '192.168.1.20',
        port:               22,
        user:               'weather',
        key_path:           '/fake/id_ed25519',
        command_timeout_ms: 5000,
      },
      database: {
        path:      '/home/weather/app/data/weather.db',
        read_only: true,
      },
      process_supervisor: {
        type:         'systemd',
        service_name: 'weather-station',
      },
      operator: {
        email:                           'operator@test.local',
        name:                            'Test Operator',
        approval_timeout_minutes:        30,
        urgent_approval_timeout_minutes: 5,
      },
      cron: {
        health_check:  '0 * * * *',
        backup:        '0 3 * * *',
        backup_verify: '5 3 * * *',
        archive_check: '10 3 * * *',
        shift_report:  '0 6 * * *',
        weekly_digest: '0 2 * * 1',
      },
      tools: {
        health_check: { enabled: true, http_check: true, process_check: true, ssh_connectivity_check: true },
        db_query:     { enabled: true, max_row_return: 100, query_timeout_ms: 15000 },
        db_integrity: { enabled: true, run_wal_checkpoint: true },
        backup:       { enabled: true, backup_dir: '/tmp/cosa-backups', timeout_s: 120 },
      },
      security: {
        dangerous_commands: [
          { pattern: 'rm\\s+-rf',        reason: 'Recursive delete' },
          { pattern: 'DROP\\s+TABLE',     reason: 'Destructive SQL' },
          { pattern: 'DROP\\s+DATABASE',  reason: 'Destructive SQL' },
          { pattern: 'killall|pkill|kill\\s+-9', reason: 'Process kill' },
        ],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Temp directory helpers
// ---------------------------------------------------------------------------

/**
 * Create a unique writable temp directory for one test file's DB + data.
 * @returns {string}
 */
function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cosa-phase2-'));
}

// ---------------------------------------------------------------------------
// SSH output fixtures
// ---------------------------------------------------------------------------

const SYSTEMCTL_HEALTHY = [
  'ActiveState=active',
  'SubState=running',
  'ExecMainStartTimestamp=Mon 2026-03-29 08:00:00 UTC',
  'NRestarts=0',
].join('\n') + '\n';

const SYSTEMCTL_DEGRADED = [
  'ActiveState=active',
  'SubState=running',
  'ExecMainStartTimestamp=Mon 2026-03-29 06:00:00 UTC',
  'NRestarts=2',
].join('\n') + '\n';

// ---------------------------------------------------------------------------
// Claude API response builders
// ---------------------------------------------------------------------------

/**
 * Build a Claude tool_use response (single tool).
 */
function claudeToolUse(toolName, input = {}) {
  return {
    id:          'msg_tool_p2',
    type:        'message',
    role:        'assistant',
    content:     [{ type: 'tool_use', id: 'tc_p2_1', name: toolName, input }],
    model:       'claude-sonnet-4-6',
    stop_reason: 'tool_use',
    usage:       { input_tokens: 180, output_tokens: 70 },
  };
}

/**
 * Build a Claude tool_use response for two sequential tools in one turn.
 */
function claudeTwoToolUse(toolName1, input1 = {}, toolName2, input2 = {}) {
  return {
    id:          'msg_tool_p2_two',
    type:        'message',
    role:        'assistant',
    content:     [
      { type: 'tool_use', id: 'tc_p2_1', name: toolName1, input: input1 },
      { type: 'tool_use', id: 'tc_p2_2', name: toolName2, input: input2 },
    ],
    model:       'claude-sonnet-4-6',
    stop_reason: 'tool_use',
    usage:       { input_tokens: 200, output_tokens: 90 },
  };
}

/**
 * Build a Claude end_turn text response.
 */
function claudeEndTurn(text = 'Done.') {
  return {
    id:          'msg_end_p2',
    type:        'message',
    role:        'assistant',
    content:     [{ type: 'text', text }],
    model:       'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    usage:       { input_tokens: 220, output_tokens: 100 },
  };
}

// ---------------------------------------------------------------------------
// SSH output for backup tool
// ---------------------------------------------------------------------------

/**
 * Simulate successful backup_run SSH output.
 *
 * @param {string} ts   - ISO timestamp for filenames.
 * @param {string} dir  - Backup directory.
 * @returns {string}
 */
function backupRunOutput(ts = '2026-03-29T03:00:00.000Z', dir = '/tmp/cosa-backups') {
  const fileTs   = ts.replace(/:/g, '-').replace(/\./g, '-');
  const filePath = `${dir}/weather-${fileTs}.jsonl`;
  const rowCount = 100;
  const hash     = 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1';
  return [
    `BACKUP_PATH=${filePath}`,
    `ROW_COUNT=${rowCount}`,
    `SHA256=${hash}`,
    `COMPLETED_AT=${ts}`,
    'EXIT=0',
  ].join('\n') + '\n';
}

/**
 * Simulate successful backup_verify SSH output.
 */
function backupVerifyOutput(verified = true) {
  return verified
    ? 'VERIFY=ok\nEXIT=0\n'
    : 'VERIFY=mismatch\nEXPECTED=abc123\nACTUAL=deadbeef\nEXIT=1\n';
}

// ---------------------------------------------------------------------------
// Async utilities
// ---------------------------------------------------------------------------

const flushPromises = () => new Promise(resolve => setImmediate(resolve));

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  makeStagingConfig,
  makeTempDataDir,
  SYSTEMCTL_HEALTHY,
  SYSTEMCTL_DEGRADED,
  claudeToolUse,
  claudeTwoToolUse,
  claudeEndTurn,
  backupRunOutput,
  backupVerifyOutput,
  flushPromises,
};
