'use strict';

/**
 * Session judge — LLM-as-judge (Verification Loop spec, Layer B).
 *
 * After an action-role session closes, a cheap Haiku reviewer grades whether
 * the session's objective was *actually* achieved — not merely whether the loop
 * exited cleanly. The verdict gates skill authoring, is persisted for audit, and
 * (optionally) raises an operator alert on a silent failure.
 *
 * This is INFERENTIAL verification (semantic). It composes with Layer A's
 * COMPUTATIONAL verification: any "COSA VERIFICATION" block already in the
 * transcript is ground truth, and the judge is instructed to defer to it.
 *
 * Uses a forced tool call for a structured, schema-validated verdict — far more
 * reliable than parsing free-text JSON. Best-effort: every failure path returns
 * a well-defined { verdict: 'uncertain', confidence: 0 } so callers always have
 * a safe default for their gating logic.
 */

const Anthropic        = require('@anthropic-ai/sdk');
const { createLogger } = require('./logger');

const log = createLogger('session-judge');

/** Cheap model for grading — same tier used for skill generation / probes. */
const DEFAULT_JUDGE_MODEL = 'claude-haiku-4-5-20251001';
const JUDGE_MAX_TOKENS    = 512;

const VALID_VERDICTS = ['resolved', 'unresolved', 'uncertain'];

/** Forced-call tool the judge must use to return its structured verdict. */
const VERDICT_TOOL = {
  name: 'record_verdict',
  description: 'Record whether the session achieved its stated objective.',
  input_schema: {
    type: 'object',
    properties: {
      verdict:    { type: 'string', enum: VALID_VERDICTS },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reason:     { type: 'string', maxLength: 280 },
    },
    required: ['verdict', 'confidence', 'reason'],
  },
};

const SYSTEM_PROMPT = [
  'You are a strict QA reviewer for COSA, an autonomous operations agent that manages a',
  'restaurant point-of-sale appliance. Given the session OBJECTIVE and what the agent',
  'actually DID — its tool calls, their outcomes, and its final message — decide whether',
  'the objective was genuinely achieved.',
  '',
  'Rules:',
  '- Prefer "unresolved" or "uncertain" over a charitable "resolved". A confident-sounding',
  '  final message is NOT evidence; tool outcomes are.',
  '- Any "COSA VERIFICATION" block in the transcript is GROUND TRUTH. If a re-probe says',
  '  NOT CONFIRMED or INCONCLUSIVE, the objective is NOT "resolved" no matter what the',
  "  agent's summary claims.",
  '- "resolved": the objective was achieved and, where checkable, confirmed.',
  '- "unresolved": the objective was clearly not achieved, or a mutating action did not verify.',
  '- "uncertain": there is not enough evidence to decide either way.',
  '',
  'Call record_verdict exactly once.',
].join('\n');

/** Safe fallback returned on any failure so gating logic is never undefined. */
const SAFE_DEFAULT = Object.freeze({ verdict: 'uncertain', confidence: 0, reason: 'judge unavailable' });

/**
 * Render the session into the user message the judge grades.
 *
 * @param {{ objective: string, toolCalls: Array, finalText: string }} p
 * @returns {string}
 */
function _buildUserContent({ objective, toolCalls, finalText }) {
  const lines = [`OBJECTIVE:\n${objective || '(none provided)'}`, '', 'TOOL CALLS (in order):'];

  if (!toolCalls.length) {
    lines.push('  (none)');
  } else {
    toolCalls.forEach((tc, i) => {
      const out = tc.output != null ? JSON.stringify(tc.output) : '(no output)';
      lines.push(`  ${i + 1}. ${tc.tool_name}(${JSON.stringify(tc.input ?? {})}) -> ${out.slice(0, 600)}`);
    });
  }

  lines.push('', `AGENT FINAL MESSAGE:\n${(finalText || '').slice(0, 1200)}`);
  return lines.join('\n');
}

/**
 * Grade whether a completed session achieved its objective.
 *
 * @param {{
 *   objective:  string,
 *   toolCalls:  Array<{ tool_name: string, input?: object, output?: object|null }>,
 *   finalText:  string,
 *   apiKey:     string,
 *   model?:     string,
 * }} params
 * @returns {Promise<{ verdict: 'resolved'|'unresolved'|'uncertain', confidence: number, reason: string }>}
 */
async function judgeSession({ objective, toolCalls = [], finalText = '', apiKey, model }) {
  try {
    const client   = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model:       model || DEFAULT_JUDGE_MODEL,
      max_tokens:  JUDGE_MAX_TOKENS,
      system:      SYSTEM_PROMPT,
      tools:       [VERDICT_TOOL],
      tool_choice: { type: 'tool', name: 'record_verdict' },
      messages:    [{ role: 'user', content: _buildUserContent({ objective, toolCalls, finalText }) }],
    });

    const block = (response.content ?? []).find(
      b => b.type === 'tool_use' && b.name === 'record_verdict'
    );
    if (!block) {
      log.warn('Judge response had no record_verdict tool_use block');
      return { ...SAFE_DEFAULT, reason: 'judge returned no verdict' };
    }

    const { verdict, confidence, reason } = block.input ?? {};
    if (!VALID_VERDICTS.includes(verdict)) {
      log.warn(`Judge returned invalid verdict: ${JSON.stringify(verdict)}`);
      return { ...SAFE_DEFAULT, reason: 'judge returned invalid verdict' };
    }

    return {
      verdict,
      confidence: typeof confidence === 'number' ? confidence : 0,
      reason:     typeof reason === 'string' ? reason : '',
    };
  } catch (err) {
    log.error(`Judge call failed: ${err.message}`);
    return { ...SAFE_DEFAULT, reason: `judge error: ${err.message}` };
  }
}

module.exports = { judgeSession, VERDICT_TOOL };
