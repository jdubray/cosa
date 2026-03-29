'use strict';

const crypto     = require('crypto');
const Anthropic  = require('@anthropic-ai/sdk');
const { getConfig }                        = require('../config/cosa.config');
const {
  createSession,
  closeSession,
  saveTurn,
  saveToolCall,
  recordBlockedToolCall,
}                                          = require('./session-store');
const securityGate     = require('./security-gate');
const approvalEngine   = require('./approval-engine');
const toolRegistry     = require('./tool-registry');
const contextBuilder   = require('./context-builder');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Anthropic model used for all Phase 1 sessions. */
const MODEL = 'claude-sonnet-4-6';

/** Hard cap on agent-loop iterations to prevent infinite loops. */
const MAX_ITERATIONS = 20;

/** Maximum tokens per Claude response. */
const MAX_TOKENS = 4096;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


/**
 * Extract the first plain-text block from a Claude response content array.
 *
 * @param {Array<{type: string, text?: string}>} contentBlocks
 * @returns {string}
 */
function extractFinalText(contentBlocks) {
  const textBlock = contentBlocks.find(b => b.type === 'text');
  return textBlock?.text ?? '';
}

// ---------------------------------------------------------------------------
// Tool-call processing
// ---------------------------------------------------------------------------

/**
 * Run all gates and execute a single tool_use block from Claude's response.
 *
 * Flow:
 *   1. security gate  → block if dangerous
 *   2. approval gate  → await operator if medium/high/critical risk
 *   3. dispatch       → execute via tool registry
 *   4. sanitize       → strip credentials from output
 *
 * @param {string} sessionId
 * @param {{ type: 'tool_use', id: string, name: string, input: object }} toolUse
 * @returns {Promise<{ type: 'tool_result', tool_use_id: string,
 *                     content: string, is_error?: boolean }>}
 */
async function processToolUse(sessionId, toolUse) {
  const { name, id, input } = toolUse;
  const riskLevel           = toolRegistry.getRiskLevel(name);
  const toolCallRecord      = { tool_name: name, input };

  // ── 1. Security gate ────────────────────────────────────────────────────────
  const gateResult = securityGate.check(toolCallRecord);
  if (gateResult.blocked) {
    recordBlockedToolCall(sessionId, toolCallRecord, gateResult.reason);
    return {
      type:        'tool_result',
      tool_use_id: id,
      content:     `Tool call blocked by security gate: ${gateResult.reason}`,
      is_error:    true,
    };
  }

  // ── 2. Approval gate ────────────────────────────────────────────────────────
  const policy = approvalEngine.requiresApproval({ tool_name: name, input, riskLevel });

  if (policy === 'once') {
    const approvalResult = await approvalEngine.requestApproval(
      sessionId,
      {
        tool_name:      name,
        input,
        riskLevel,
        action_summary: `Execute ${name} tool`,
      },
      'once'
    );

    if (!approvalResult.approved) {
      saveToolCall(
        sessionId,
        { tool_name: name, input, risk_level: riskLevel },
        null,
        'denied'
      );
      const note = approvalResult.note ? `: ${approvalResult.note}` : '';
      return {
        type:        'tool_result',
        tool_use_id: id,
        content:     `Tool call denied by operator${note}`,
        is_error:    true,
      };
    }
  }

  // ── 3. Dispatch ─────────────────────────────────────────────────────────────
  let rawOutput;
  try {
    rawOutput = await toolRegistry.dispatch(name, input);
  } catch (err) {
    rawOutput = { error: err.message, code: err.code ?? 'TOOL_ERROR' };
  }

  saveToolCall(
    sessionId,
    { tool_name: name, input, risk_level: riskLevel },
    rawOutput,
    'executed'
  );

  // ── 4. Sanitize output before it enters the conversation history ─────────────
  const sanitized = securityGate.sanitizeOutput(rawOutput);

  return {
    type:        'tool_result',
    tool_use_id: id,
    content:     sanitized,
  };
}

// ---------------------------------------------------------------------------
// Core agent loop
// ---------------------------------------------------------------------------

/**
 * Run a COSA agent session for the given trigger.
 *
 * Creates a session in session.db, enters an agentic loop calling Claude,
 * dispatches any tool calls through the security and approval gates, and
 * returns the final text response once the model emits `stop_reason: end_turn`
 * or the iteration cap is reached.
 *
 * @param {{ type: string, source: string, message: string }} trigger
 * @returns {Promise<{ session_id: string, response: string }>}
 * @throws {Error} On Claude API failure or unhandled tool error (session is
 *   closed with an error summary before re-throwing).
 */
async function runSession(trigger) {
  const { env } = getConfig();
  const sessionId = crypto.randomUUID();

  createSession(sessionId, { type: trigger.type, source: trigger.source });

  const systemPrompt = contextBuilder.build();
  const tools        = toolRegistry.getSchemas();
  const messages     = [{ role: 'user', content: trigger.message }];

  saveTurn(sessionId, 'user', trigger.message, null, null);

  const client = new Anthropic({ apiKey: env.anthropicApiKey });

  let finalText  = '';
  let iterations = 0;

  try {
    while (iterations < MAX_ITERATIONS) {
      iterations++;

      const response = await client.messages.create({
        model:      MODEL,
        max_tokens: MAX_TOKENS,
        system:     systemPrompt,
        tools,
        messages,
      });

      // ── Log assistant turn ────────────────────────────────────────────────
      saveTurn(
        sessionId,
        'assistant',
        JSON.stringify(response.content),
        response.usage?.input_tokens  ?? null,
        response.usage?.output_tokens ?? null
      );

      messages.push({ role: 'assistant', content: response.content });

      // ── Check termination conditions ──────────────────────────────────────
      if (response.stop_reason === 'end_turn') {
        finalText = extractFinalText(response.content);
        break;
      }

      if (response.stop_reason !== 'tool_use') {
        // max_tokens, stop_sequence, or other — treat as terminal
        finalText = extractFinalText(response.content);
        break;
      }

      // ── Process tool calls ────────────────────────────────────────────────
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      const toolResults   = [];

      for (const toolUse of toolUseBlocks) {
        const result = await processToolUse(sessionId, toolUse);
        toolResults.push(result);
      }

      messages.push({ role: 'user', content: toolResults });
      saveTurn(sessionId, 'tool', JSON.stringify(toolResults), null, null);
    }

    // ── Graceful max-iterations message ──────────────────────────────────────
    if (finalText === '') {
      finalText = 'Maximum iterations (20) reached without a final response.';
    }

    closeSession(sessionId, finalText.slice(0, 500));
    return { session_id: sessionId, response: finalText };

  } catch (err) {
    closeSession(sessionId, `Error: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { runSession };
