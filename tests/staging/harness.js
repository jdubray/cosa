'use strict';

/**
 * Shared fixtures and helpers for the COSA staging (integration) test suite.
 *
 * Each staging test file must declare its own jest.mock() calls (Jest's
 * hoisting requirement).  This module provides:
 *   - makeStagingConfig(dataDir) — synthetic config object
 *   - SSH output fixtures
 *   - Claude API response builders
 *   - IMAP message builder
 *   - flushPromises() utility
 */

const os   = require('os');
const path = require('path');

// ---------------------------------------------------------------------------
// Config factory
// ---------------------------------------------------------------------------

/**
 * Build a synthetic COSA config for staging tests.
 * All external service credentials are placeholders; only `dataDir` is real.
 *
 * @param {string} dataDir - Absolute path to a writable temp directory.
 * @returns {{ env: object, appliance: object }}
 */
function makeStagingConfig(dataDir) {
  return {
    env: {
      anthropicApiKey: 'sk-ant-staging-test-key',
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
      name: 'Baanbaan POS (Staging)',
      appliance_api: {
        base_url:              'http://192.168.1.10:3000',
        health_endpoint:       '/health',
        health_ready_endpoint: '/health/ready',
        request_timeout_ms:    2000,
      },
      ssh: {
        host:               '192.168.1.10',
        port:               22,
        user:               'baanbaan',
        key_path:           '/fake/id_ed25519',
        command_timeout_ms: 5000,
      },
      database: {
        path:      '/home/baanbaan/app/data/baanbaan.db',
        read_only: true,
      },
      process_supervisor: {
        type:         'systemd',
        service_name: 'baanbaan',
      },
      operator: {
        email:                           'operator@test.local',
        name:                            'Test Operator',
        approval_timeout_minutes:        30,
        urgent_approval_timeout_minutes: 5,
      },
      cron: {
        health_check: '0 * * * *',
      },
      tools: {
        health_check: { enabled: true, http_check: true, process_check: true, ssh_connectivity_check: true },
        db_query:     { enabled: true, max_row_return: 100, query_timeout_ms: 15000 },
        db_integrity: { enabled: true, run_wal_checkpoint: true },
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
 * Create a unique writable temp directory for one test file's DB.
 *
 * @returns {string} Absolute path to the new directory.
 */
function makeTempDataDir() {
  return require('fs').mkdtempSync(
    path.join(os.tmpdir(), 'cosa-staging-')
  );
}

// ---------------------------------------------------------------------------
// SSH output fixtures
// ---------------------------------------------------------------------------

/** systemctl output for a fully healthy baanbaan unit. */
const SYSTEMCTL_HEALTHY = [
  'ActiveState=active',
  'SubState=running',
  'ExecMainStartTimestamp=Mon 2026-03-28 10:00:00 UTC',
  'NRestarts=0',
].join('\n') + '\n';

/**
 * systemctl output for a degraded unit — non-zero restart count causes
 * the health_check tool to return overall_status='degraded'.
 */
const SYSTEMCTL_DEGRADED = [
  'ActiveState=active',
  'SubState=running',
  'ExecMainStartTimestamp=Mon 2026-03-28 08:00:00 UTC',
  'NRestarts=3',
].join('\n') + '\n';

// ---------------------------------------------------------------------------
// Claude API response builders
// ---------------------------------------------------------------------------

/**
 * Build a Claude tool_use response that causes the orchestrator to dispatch
 * the named tool.
 *
 * @param {string} toolName
 * @param {object} [input={}]
 * @returns {object} Anthropic messages.create response shape.
 */
function claudeToolUse(toolName, input = {}) {
  return {
    id:          'msg_tool_staging',
    type:        'message',
    role:        'assistant',
    content:     [{ type: 'tool_use', id: 'tc_staging_1', name: toolName, input }],
    model:       'claude-sonnet-4-6',
    stop_reason: 'tool_use',
    usage:       { input_tokens: 150, output_tokens: 60 },
  };
}

/**
 * Build a Claude end_turn response carrying a plain-text reply.
 *
 * @param {string} [text='Done.']
 * @returns {object} Anthropic messages.create response shape.
 */
function claudeEndTurn(text = 'Done.') {
  return {
    id:          'msg_end_staging',
    type:        'message',
    role:        'assistant',
    content:     [{ type: 'text', text }],
    model:       'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    usage:       { input_tokens: 200, output_tokens: 90 },
  };
}

// ---------------------------------------------------------------------------
// IMAP message builder
// ---------------------------------------------------------------------------

let _imapSeq = 1;

/**
 * Build a mock IMAP message object in the shape that ImapFlow.fetchOne returns.
 *
 * @param {string} from     - Sender email address.
 * @param {string} subject
 * @param {string} body     - Plain-text body content.
 * @returns {object}
 */
function makeImapMessage(from, subject, body) {
  return {
    uid: _imapSeq++,
    envelope: {
      from:      [{ address: from }],
      subject,
      messageId: `<staging-${Date.now()}-${_imapSeq}@test.local>`,
    },
    bodyParts: new Map([['TEXT', Buffer.from(body)]]),
  };
}

// ---------------------------------------------------------------------------
// Async utilities
// ---------------------------------------------------------------------------

/**
 * Flush the microtask queue so that mocked Promises resolve before the next
 * assertion.  Uses setImmediate (macro-task) which runs after all pending
 * microtasks have settled.
 *
 * @returns {Promise<void>}
 */
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
  claudeEndTurn,
  makeImapMessage,
  flushPromises,
};
