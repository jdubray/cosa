'use strict';

const Anthropic        = require('@anthropic-ai/sdk');
const { getConfig }    = require('../config/cosa.config');
const { createLogger } = require('./logger');

const log = createLogger('intent-classifier');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cheap, fast model for routing. No tools, JSON-only output. */
const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';

/** Token budget for the classifier reply — a single small JSON object. */
const CLASSIFIER_MAX_TOKENS = 64;

/**
 * Regex fast-path keyword sets (2.0 plan §5.3 / spec §5.3).
 *
 * If exactly one side matches we classify directly with confidence 0.9 and skip
 * the Haiku call entirely.  If both or neither match we fall through to Haiku.
 */
const QUERY_RE   = /\b(what|how many|show|list|report|status|who|when|is there|are there|explain|why|which)\b/i;
const COMMAND_RE = /\b(restart|reboot|stop|pause|resume|enable|disable|backup|update|change|set|rotate|kill|cancel|delete|remove|add|create|fix|run)\b/i;

const SYSTEM_PROMPT = [
  'You are a router for an operations agent. Classify the operator\'s message.',
  'Reply with exactly one JSON object and nothing else:',
  '{"intent":"query"|"command"|"ambiguous","confidence":0.0-1.0}',
  'query   = asking for information, status, reports, explanations',
  'command = requesting an action, change, restart, update, configuration',
  'ambiguous = cannot be determined without more context',
].join('\n');

const VALID_INTENTS = ['query', 'command', 'ambiguous'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the first JSON object from a model reply, tolerating surrounding
 * prose or markdown fences.
 *
 * @param {string} text
 * @returns {object} parsed object
 * @throws {Error} if no parseable JSON object is found
 */
function parseClassification(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('no JSON object in classifier reply');
  return JSON.parse(match[0]);
}

/**
 * Clamp a self-reported confidence into [0, 1], defaulting to 0.5 when absent
 * or non-numeric.
 *
 * @param {unknown} value
 * @returns {number}
 */
function normalizeConfidence(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify an operator email into a routing intent.
 *
 * Tries the regex fast path first (no API call). Falls back to a single Haiku
 * call. Any failure — API error, malformed JSON, unknown intent — resolves to
 * `'ambiguous'`, which the caller routes conservatively to the Action Agent.
 *
 * @param {string} emailText - Combined subject + body of the operator email.
 * @returns {Promise<{ intent: 'query'|'command'|'ambiguous', confidence: number, raw: string }>}
 */
async function classify(emailText) {
  const text = (emailText ?? '').trim();

  // ── 1. Regex fast path ────────────────────────────────────────────────────
  const isQuery   = QUERY_RE.test(text);
  const isCommand = COMMAND_RE.test(text);
  if (isQuery && !isCommand) return { intent: 'query',   confidence: 0.9, raw: 'regex' };
  if (isCommand && !isQuery) return { intent: 'command', confidence: 0.9, raw: 'regex' };

  // ── 2. Haiku fallback (both or neither matched) ───────────────────────────
  try {
    const { env } = getConfig();
    const client  = new Anthropic({ apiKey: env.anthropicApiKey });
    const response = await client.messages.create({
      model:      CLASSIFIER_MODEL,
      max_tokens: CLASSIFIER_MAX_TOKENS,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: text || '(empty message)' }],
    });

    const out = (response.content ?? [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    const parsed = parseClassification(out);
    if (!VALID_INTENTS.includes(parsed.intent)) {
      throw new Error(`unexpected intent "${parsed.intent}"`);
    }

    return {
      intent:     parsed.intent,
      confidence: normalizeConfidence(parsed.confidence),
      raw:        out,
    };
  } catch (err) {
    log.warn(`classify failed, defaulting to ambiguous: ${err.message}`);
    return { intent: 'ambiguous', confidence: 0.0, raw: `error: ${err.message}` };
  }
}

module.exports = { classify, QUERY_RE, COMMAND_RE };
