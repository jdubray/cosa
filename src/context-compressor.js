'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { getConfig } = require('../config/cosa.config');
const { saveTurn, markSessionCompressed } = require('./session-store');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Prefix prepended to the summary message injected into the message array. */
const SUMMARY_PREFIX = '[Context summary — prior turns compressed]';

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/**
 * Load context-compression settings from appliance config, falling back to
 * safe defaults if the config is absent or the section is missing.
 *
 * @returns {{
 *   enabled:               boolean,
 *   maxTurnsBeforeCompress: number,
 *   protectFirstN:         number,
 *   protectLastN:          number,
 *   compressionModel:      string,
 * }}
 */
function _getConfig() {
  try {
    const { appliance } = getConfig();
    const cc = appliance.context_compression ?? {};
    return {
      enabled:                cc.enabled               !== false,
      maxTurnsBeforeCompress: cc.max_turns_before_compress ?? 12,
      protectFirstN:          cc.protect_first_n           ?? 3,
      protectLastN:           cc.protect_last_n            ?? 4,
      compressionModel:       cc.compression_model         ?? 'claude-haiku-4-5-20251001',
    };
  } catch {
    return {
      enabled:                true,
      maxTurnsBeforeCompress: 12,
      protectFirstN:          3,
      protectLastN:           4,
      compressionModel:       'claude-haiku-4-5-20251001',
    };
  }
}

// ---------------------------------------------------------------------------
// Core compression logic
// ---------------------------------------------------------------------------

/**
 * Build the Haiku compression prompt for the middle turns.
 *
 * @param {Array} middleTurns
 * @returns {string}
 */
function _buildCompressionPrompt(middleTurns) {
  // Encode the turns as base64 so that tool output containing XML-like strings
  // (e.g. </turns>) cannot escape the delimiter boundary.
  const encoded = Buffer.from(JSON.stringify(middleTurns)).toString('base64');
  return [
    'The following is a base64-encoded JSON array of COSA agent session turns.',
    'Decode and summarize the turns.',
    'Preserve: decisions made, tools called, outcomes, open questions.',
    'Be concise. Target: 300 words or less.',
    `<turns_b64>${encoded}</turns_b64>`,
  ].join('\n');
}

/**
 * Call Haiku to summarize the middle turns and return the compressed array.
 * Also logs a system-role turn to session.db and marks the session as compressed.
 *
 * @param {Array} messages
 * @param {string} sessionId
 * @param {string} apiKey
 * @returns {Promise<Array>} Compressed message array.
 */
async function _runCompression(messages, sessionId, apiKey) {
  const {
    protectFirstN,
    protectLastN,
    compressionModel,
  } = _getConfig();

  const head   = messages.slice(0, protectFirstN);
  const middle = messages.slice(protectFirstN, messages.length - protectLastN);
  const tail   = messages.slice(messages.length - protectLastN);

  const prompt   = _buildCompressionPrompt(middle);
  const client   = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model:      compressionModel,
    max_tokens: 1024,
    messages:   [{ role: 'user', content: prompt }],
  });

  const summaryText = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  const summaryMessage = {
    role:    'user',
    content: `${SUMMARY_PREFIX}\n\n${summaryText}`,
  };

  const compressed = [...head, summaryMessage, ...tail];

  // ── Log to session.db ──────────────────────────────────────────────────────
  saveTurn(
    sessionId,
    'system',
    `Context compressed: ${middle.length} turns → 1 summary`,
    null,
    null
  );

  // ── Mark session as having been compressed ─────────────────────────────────
  markSessionCompressed(sessionId);

  return compressed;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return true when the message array is long enough to require compression.
 * Reads `maxTurnsBeforeCompress` from appliance config (default: 12).
 *
 * @param {Array} messages - The orchestrator's live message array.
 * @returns {boolean}
 */
function needsCompression(messages) {
  const { enabled, maxTurnsBeforeCompress } = _getConfig();
  return enabled && messages.length > maxTurnsBeforeCompress;
}

/**
 * Compress the middle portion of the message array via Haiku.
 *
 * Protects `protectFirstN` (default: 3) messages at the head and
 * `protectLastN` (default: 4) at the tail.  The summary is injected as a
 * single `user` message prefixed with {@link SUMMARY_PREFIX}.
 *
 * The returned array length equals `protectFirstN + 1 + protectLastN` (8
 * with default config).
 *
 * @param {Array} messages - Full current message array.
 * @param {string} sessionId - Used to log and mark the session in session.db.
 * @returns {Promise<Array>} New compressed message array.
 */
async function compress(messages, sessionId) {
  const { enabled } = _getConfig();
  if (!enabled) return messages;
  const { env } = getConfig();
  return _runCompression(messages, sessionId, env.anthropicApiKey);
}

/**
 * SAM acceptor factory — guards the model against unneeded compression.
 *
 * The returned acceptor is curried in the SAM style: `model => proposal => {}`.
 * It does nothing (no model mutation, no Haiku call) when the proposal
 * carries `compressionNeeded: false`, satisfying the requirement that the
 * acceptor rejects if {@link needsCompression} returned false.
 *
 * When `compressionNeeded` is true, it replaces `model.messages` with the
 * already-computed `compressedMessages` from the proposal.
 *
 * Usage:
 * ```js
 * samApi.addAcceptors([ contextCompressor.makeCompressionAcceptor() ]);
 * ```
 *
 * @returns {(model: object) => (proposal: object) => void}
 */
function makeCompressionAcceptor() {
  return model => proposal => {
    // Guard: acceptor rejects if compression was not needed.
    if (!proposal.compressionNeeded) return;
    // AC5: Transition to 'compressing' state while the compressed array is being
    // applied.  The orchestrator's claudeResponseAcceptor resets this to 'running'
    // (or 'complete') in the same acceptor pass.
    model.status   = 'compressing';
    model.messages = proposal.compressedMessages;
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  needsCompression,
  compress,
  makeCompressionAcceptor,
};
