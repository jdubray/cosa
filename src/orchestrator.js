'use strict';

const crypto    = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { createInstance, api } = require('@cognitive-fab/sam-pattern');
const { getConfig }           = require('../config/cosa.config');
const {
  createSession,
  closeSession,
  saveTurn,
  saveToolCall,
  recordBlockedToolCall,
  getSessionToolCalls,
  updateApprovalToolCallId,
}                             = require('./session-store');
const { postSessionHook }     = require('./post-session-hook');
const securityGate   = require('./security-gate');
const approvalEngine = require('./approval-engine');
const actionVerifier = require('./action-verifier');
const toolRegistry   = require('./tool-registry');
const contextBuilder = require('./context-builder');
const memoryManager      = require('./memory-manager');
const skillStore         = require('./skill-store');
const contextCompressor  = require('./context-compressor');
const { makeReactor }    = require('./session-fsm');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Model used for cron sessions — tool-call → format-response tasks that don't
 * require deep reasoning.  ~12× cheaper than Sonnet.
 */
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Model used for operator (email) sessions — richer reasoning, multi-step
 * diagnosis, and more nuanced operator communication.
 */
const SONNET_MODEL = 'claude-sonnet-4-6';

/**
 * Hard cap on agent-loop iterations to prevent infinite loops.
 *
 * Email sessions (operator-initiated) allow more iterations because the
 * operator may ask multi-step questions that require several tool round-trips.
 * Cron sessions are single-focused tasks and 20 is sufficient.
 */
const MAX_ITERATIONS_EMAIL = 20;
const MAX_ITERATIONS_CRON  = 20;

/**
 * Max tokens for operator sessions — generous budget so security/compliance
 * digests are never silently truncated mid-sentence.
 */
const OPERATOR_MAX_TOKENS = 8192;

/**
 * Max tokens for cron sessions — cron responses are short tool summaries;
 * 2048 is well above any realistic output.
 */
const CRON_MAX_TOKENS = 2048;

/**
 * Max tokens for the Audit Agent — its weekly report is longer than a cron
 * summary but shorter than an operator diagnosis.
 */
const AUDIT_MAX_TOKENS = 4096;

// ---------------------------------------------------------------------------
// Per-role execution profiles (multi-agent harness, 2.0)
// ---------------------------------------------------------------------------

/** Model selected per agent role. */
const MODEL_BY_ROLE = {
  probe:  HAIKU_MODEL,
  query:  SONNET_MODEL,
  action: SONNET_MODEL,
  audit:  HAIKU_MODEL,
};

/** Max output tokens per agent role. */
const MAX_TOKENS_BY_ROLE = {
  probe:  CRON_MAX_TOKENS,
  query:  OPERATOR_MAX_TOKENS,
  action: OPERATOR_MAX_TOKENS,
  audit:  AUDIT_MAX_TOKENS,
};

/** Agent-loop iteration cap per agent role. */
const MAX_ITER_BY_ROLE = {
  probe:  MAX_ITERATIONS_CRON,
  query:  MAX_ITERATIONS_EMAIL,
  action: MAX_ITERATIONS_EMAIL,
  audit:  10,
};

/**
 * Resolve the agent role for a session.
 *
 * An explicit `options.role` always wins.  Otherwise the role is derived from
 * the trigger type for backward compatibility: cron → probe, everything else
 * (email, cli) → action (the safe, full-capability default).
 *
 * @param {{ type: string }} trigger
 * @param {{ role?: string }} options
 * @returns {string}
 */
function deriveRole(trigger, options) {
  if (options.role) return options.role;
  if (trigger.type === 'cron') return 'probe';
  return 'action';
}

/**
 * Maximum byte length of a serialised tool output before it is truncated.
 * Keeps individual tool results from ballooning the context window.
 */
const TOOL_OUTPUT_MAX_BYTES = 50 * 1024; // 50 KB

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
  return contentBlocks
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
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
async function processToolUse(sessionId, toolUse, triggerType, role) {
  const { name, id, input } = toolUse;
  let riskLevel             = toolRegistry.getRiskLevel(name);
  let approvalId            = null;
  const toolCallRecord      = { tool_name: name, input };

  // ── 0. Role gate ────────────────────────────────────────────────────────────
  // Hard execution-time enforcement of the role→risk boundary. getSchemas(role)
  // only filters what each role is *shown*; this ensures a read-only role
  // (query/probe/audit) can never actually run a mutating tool even if one
  // appears in a tool_use block (hallucination or prompt injection).
  if (!toolRegistry.isToolPermittedForRole(role, name)) {
    const reason = `tool "${name}" (risk: ${riskLevel}) is not permitted for the "${role}" role`;
    recordBlockedToolCall(sessionId, toolCallRecord, reason);
    return {
      type:        'tool_result',
      tool_use_id: id,
      content:     `Tool call blocked: ${reason}`,
      is_error:    true,
    };
  }

  // Dynamic risk resolution: appliance_api_call stores 'dynamic' in the
  // registry because the actual risk level depends on the endpoint chosen
  // at call time.  Resolve it here before the approval gate runs.
  if (riskLevel === 'dynamic') {
    const endpointName = input.endpoint_name;
    const entry = (getConfig().appliance?.appliance_api?.api_endpoints ?? [])
      .find(e => e.name === endpointName);
    if (!entry) {
      // Endpoint not in the allowlist — fail closed. The handler will reject it,
      // but the risk decision must not auto-approve an unknown endpoint: treat
      // it as 'high' so it cannot slip through if the handler ever changes.
      riskLevel = 'high';
    } else {
      riskLevel = entry.risk ?? 'high';
    }
  }

  // ── 1. Security gate ────────────────────────────────────────────────────────
  // Pass the resolved risk so scanner_required mode can fail closed on high-risk
  // calls when the pre-execution scanner is unavailable.
  const gateResult = await securityGate.check({ ...toolCallRecord, risk_level: riskLevel });
  if (gateResult.blocked) {
    const blockReason = gateResult.pattern
      ? `${gateResult.reason} [pattern: ${gateResult.pattern}]`
      : gateResult.reason;
    recordBlockedToolCall(sessionId, toolCallRecord, blockReason);
    return {
      type:        'tool_result',
      tool_use_id: id,
      content:     `Tool call blocked by security gate: ${gateResult.reason}`,
      is_error:    true,
    };
  }

  // ── 2. Approval gate ────────────────────────────────────────────────────────
  const policy = approvalEngine.requiresApproval({ tool_name: name, input, riskLevel, triggerType });

  if (policy === 'once') {
    // Build a human-readable action summary.  For appliance_api_call the
    // caller may supply a `reason` field describing the intent — include it
    // so the operator sees it in the approval request email.
    let actionSummary = `Execute ${name} tool`;
    if (input.endpoint_name) {
      actionSummary = `appliance_api_call → ${input.endpoint_name}`;
    }
    if (input.reason) {
      actionSummary += `: ${input.reason}`;
    }

    const approvalResult = await approvalEngine.requestApproval(
      sessionId,
      {
        tool_name:      name,
        input,
        riskLevel,
        action_summary: actionSummary,
      },
      'once'
    );

    if (!approvalResult.approved) {
      try {
        saveToolCall(
          sessionId,
          { tool_name: name, input, risk_level: riskLevel, approval_id: approvalResult.approvalId ?? null },
          null,
          'denied'
        );
      } catch (dbErr) {
        // eslint-disable-next-line no-console
        console.warn(`[orchestrator] Failed to save denied tool call audit row: ${dbErr.message}`);
      }
      const note = approvalResult.note ? `: ${approvalResult.note}` : '';
      return {
        type:        'tool_result',
        tool_use_id: id,
        content:     `Tool call denied by operator${note}`,
        is_error:    true,
      };
    }

    approvalId = approvalResult.approvalId ?? null;
  }

  // ── 3. Dispatch ─────────────────────────────────────────────────────────────
  let rawOutput;
  let dispatchErrored = false;
  try {
    rawOutput = await toolRegistry.dispatch(name, input);
  } catch (err) {
    rawOutput = { error: err.message, code: err.code ?? 'TOOL_ERROR' };
    dispatchErrored = true;
  }

  // ── 4. Sanitize FIRST, then persist the sanitized form ───────────────────────
  // Redaction must happen before the value touches durable storage: session.db is
  // reachable via session_search / archive_search, so persisting raw output would
  // leak any secret a tool emits (e.g. in an error string) even though the copy
  // returned to the model is clean.
  const sanitized = securityGate.sanitizeOutput(rawOutput);

  const toolCallId = saveToolCall(
    sessionId,
    { tool_name: name, input, risk_level: riskLevel, approval_id: approvalId ?? null },
    sanitized,
    'executed'
  );

  // Back-fill the reverse link: approval row → tool_call row.
  if (approvalId) {
    updateApprovalToolCallId(approvalId, toolCallId);
  }

  // Guard against runaway tool output bloating the context window.
  let content =
    typeof sanitized === 'string' && sanitized.length > TOOL_OUTPUT_MAX_BYTES
      ? sanitized.slice(0, TOOL_OUTPUT_MAX_BYTES) + '\n…[output truncated to 50 KB]'
      : sanitized;

  // ── 5. Computational verification (Verification Loop spec, Layer A) ──────────
  // After an action-role session successfully runs a *mutating* tool, re-probe
  // the appliance to confirm the action achieved its objective and append the
  // verdict so the model gets deterministic ground truth on its next turn. The
  // verifier itself decides (via config policy) whether any check applies; this
  // gate just limits it to mutating action-tool calls that actually executed.
  // Appended AFTER the 50 KB truncation so the verdict can never be cut off.
  if (role === 'action' && riskLevel !== 'read' && !dispatchErrored) {
    try {
      const verdict = await actionVerifier.verify(name, input);
      if (verdict) {
        content = `${content}\n\n${actionVerifier.formatVerdict(verdict)}`;
      }
    } catch (verifyErr) {
      // Verification is best-effort and must never break the tool result.
      // eslint-disable-next-line no-console
      console.warn(`[orchestrator] action verification threw for "${name}": ${verifyErr.message}`);
    }
  }

  return {
    type:        'tool_result',
    tool_use_id: id,
    content,
  };
}

// ---------------------------------------------------------------------------
// SAM actions
// ---------------------------------------------------------------------------

/**
 * Action: optionally compress the message array, then call the Claude API.
 *
 * If the message array exceeds the compression threshold, Haiku is called
 * first to summarize the middle turns.  The compressed array (if any) is
 * returned in the proposal alongside the Claude response so the compression
 * acceptor can update `model.messages` before the response acceptor runs.
 *
 * @param {{ messages: Array, systemPrompt: Array|string, tools: Array,
 *           apiKey: string, sessionId: string }} data
 * @returns {Promise<{ response: object, compressedMessages: Array|null }>}
 */
async function callClaudeAction({ messages, systemPrompt, tools, apiKey, sessionId, model, maxTokens }) {
  let workingMessages    = messages;
  let compressedMessages = null;

  // AC1: Check compression need before every client.messages.create() call.
  if (contextCompressor.needsCompression(messages)) {
    // AC2: Replace the live messages array with the compressed one.
    workingMessages    = await contextCompressor.compress(messages, sessionId);
    compressedMessages = workingMessages;

    // AC4: Confirm the compressed array is shorter than the original.
    if (workingMessages.length >= messages.length) {
      // Compression should always reduce length; log if the invariant is violated.
      // eslint-disable-next-line no-console
      console.warn(
        `[orchestrator] Compression did not reduce message count: ` +
        `${messages.length} → ${workingMessages.length}`
      );
    }
  }

  // AC3: Claude API call proceeds with the (possibly compressed) messages array.
  // Prompt caching: mark the system prompt and the tools block as cacheable so
  // repeat iterations within the same agent loop read the static prefix from
  // cache (~10% of base input price) instead of re-billing the full prefix
  // every turn.  Cache is ephemeral (5 min TTL).
  const cachedSystem = typeof systemPrompt === 'string'
    ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
    : systemPrompt;

  const cachedTools = tools.length > 0
    ? [
        ...tools.slice(0, -1),
        { ...tools[tools.length - 1], cache_control: { type: 'ephemeral' } },
      ]
    : tools;

  const client   = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model:      model,
    max_tokens: maxTokens,
    system:     cachedSystem,
    tools:      cachedTools,
    messages:   workingMessages,
  });

  // compressionNeeded drives the compressionAcceptor guard in the SAM acceptor chain.
  return { response, compressedMessages, compressionNeeded: compressedMessages != null };
}

/**
 * Action: execute a single tool_use block through all gates.
 *
 * @param {{ toolUse: object, sessionId: string }} data
 * @returns {Promise<object>} proposal containing `{ toolResult }`
 */
async function processToolAction({ toolUse, sessionId, triggerType, role }) {
  const toolResult = await processToolUse(sessionId, toolUse, triggerType, role);
  return { toolResult };
}

// ---------------------------------------------------------------------------
// SAM acceptors  (curried: model => proposal => { mutate model })
// ---------------------------------------------------------------------------

/**
 * Acceptor A1 — guard against exceeding the per-trigger iteration cap.
 * If the model has already hit its cap, mark it complete.
 */
const iterationGuardAcceptor = model => proposal => {
  if (model.iterations >= model.maxIterations && model.status === 'running') {
    model.status    = 'complete';
    model.finalText =
      `Maximum iterations (${model.maxIterations}) reached without a final response.`;
  }
};


/**
 * Acceptor A2 — consume a Claude API response.
 * Increments the iteration counter, saves the turn, and branches on stop_reason.
 */
const claudeResponseAcceptor = model => proposal => {
  if (!proposal.response) return;

  const { response } = proposal;

  // AC5: Transition from 'compressing' back to 'running' now that compression
  // is applied and the Claude response is being consumed.  This runs in the same
  // acceptor pass as makeCompressionAcceptor(), making the 'compressing' state
  // an observable intermediate step within the session FSM.
  if (model.status === 'compressing') {
    model.status = 'running';
  }

  model.iterations++;

  try {
    saveTurn(
      model.sessionId,
      'assistant',
      JSON.stringify(response.content),
      response.usage?.input_tokens  ?? null,
      response.usage?.output_tokens ?? null
    );
  } catch (dbErr) {
    // eslint-disable-next-line no-console
    console.warn(`[orchestrator] Failed to persist assistant turn: ${dbErr.message}`);
  }

  model.messages.push({ role: 'assistant', content: response.content });

  if (response.stop_reason === 'end_turn') {
    model.status    = 'complete';
    model.finalText = extractFinalText(response.content);
    return;
  }

  if (response.stop_reason !== 'tool_use') {
    // Unexpected stop reasons: max_tokens, stop_sequence, pause_turn, refusal, etc.
    // Log so they are observable, then treat the response as a terminal turn.
    // eslint-disable-next-line no-console
    console.warn(
      `[orchestrator] Unexpected stop_reason "${response.stop_reason}" — treating session as complete`
    );
    model.status    = 'complete';
    model.finalText = extractFinalText(response.content);
    return;
  }

  // stop_reason === 'tool_use' — queue tool calls for sequential dispatch.
  model.pendingToolCalls = response.content.filter(b => b.type === 'tool_use');
  model.toolResults      = [];
  model.processingIndex  = 0;
};

/**
 * Acceptor A3 — consume a single tool result.
 * Increments processingIndex.  When all tools in the current batch are done,
 * flushes the results into the message history and clears pending state.
 */
const toolResultAcceptor = model => proposal => {
  if (!proposal.toolResult) return;

  model.toolResults.push(proposal.toolResult);
  model.processingIndex++;

  if (model.processingIndex === model.pendingToolCalls.length) {
    // All tools dispatched — push the tool-result turn and reset.
    model.messages.push({ role: 'user', content: model.toolResults });
    try {
      saveTurn(model.sessionId, 'tool', JSON.stringify(model.toolResults), null, null);
    } catch (dbErr) {
      // eslint-disable-next-line no-console
      console.warn(`[orchestrator] Failed to persist tool turn: ${dbErr.message}`);
    }
    model.pendingToolCalls = [];
    model.toolResults      = [];
    model.processingIndex  = 0;
  }
};

// ---------------------------------------------------------------------------
// SAM NAPs  (model => () => boolean|undefined)
// ---------------------------------------------------------------------------

/**
 * NAP 1 — dispatch the next pending tool call.
 * Fires when there are tool calls queued and processingIndex points to one.
 * Returns true to suppress the render cycle until the tool result arrives.
 *
 * @param {Function} processToolIntent
 */
function makeProcessToolNap(processToolIntent) {
  return model => () => {
    if (
      model.status === 'running' &&
      model.pendingToolCalls.length > 0 &&
      model.processingIndex < model.pendingToolCalls.length
    ) {
      const toolUse = model.pendingToolCalls[model.processingIndex];
      processToolIntent({ toolUse, sessionId: model.sessionId, triggerType: model.triggerType, role: model.agentRole });
      return true; // suppress render
    }
  };
}

/**
 * NAP 2 — call Claude for the next conversation turn.
 * Fires when no tool calls are pending and the session is still running.
 * Returns true to suppress the render cycle until the response arrives.
 *
 * @param {Function} callClaudeIntent
 */
function makeCallClaudeNap(callClaudeIntent) {
  return model => () => {
    if (
      model.status === 'running' &&
      model.pendingToolCalls.length === 0 &&
      model.processingIndex === 0
    ) {
      callClaudeIntent({
        messages:     model.messages,
        systemPrompt: model.systemPrompt,
        tools:        model.tools,
        apiKey:       model.apiKey,
        sessionId:    model.sessionId,
        model:        model.model,
        maxTokens:    model.maxTokens,
      });
      return true; // suppress render
    }
  };
}

// ---------------------------------------------------------------------------
// Core agent loop
// ---------------------------------------------------------------------------

/**
 * Run a COSA agent session for the given trigger using the SAM pattern.
 *
 * Creates a per-session SAM instance with:
 *   - Model: conversation state (messages, pending tool calls, status)
 *   - Acceptors: iteration guard, Claude response handler, tool result handler
 *   - NAPs: sequential tool dispatch, Claude call kickoff
 *   - Render: resolves the outer Promise when status reaches 'complete'
 *
 * @param {{ type: string, source: string, message: string }} trigger
 * @param {{ role?: string, intentRaw?: string }} [options={}]
 *   `role` selects the agent profile (model, tokens, iteration cap, tool set,
 *   Layer-0 persona); derived from the trigger when omitted.  `intentRaw` is
 *   the raw intent-classifier JSON, persisted for audit.
 * @returns {Promise<{ session_id: string, response: string }>}
 * @throws {Error} On Claude API failure or unhandled tool error.
 */
async function runSession(trigger, options = {}) {
  const { env } = getConfig();
  const sessionId = crypto.randomUUID();

  let role = deriveRole(trigger, options);

  if (!MODEL_BY_ROLE[role]) {
    // Unknown role: normalise to the Action profile (Sonnet, full tools) so the
    // model, token budget, tool set, Layer-0 persona, and stored agent_role all
    // stay in lockstep — rather than mixing an action model with an all-tools
    // schema and a personaless prompt.  Log so the gap is observable.
    // eslint-disable-next-line no-console
    console.warn(`[orchestrator] Unknown agent role "${role}" — defaulting to action profile`);
    role = 'action';
  }

  const resolvedModel    = MODEL_BY_ROLE[role];
  const resolvedTokens   = MAX_TOKENS_BY_ROLE[role];
  const resolvedMaxIter  = MAX_ITER_BY_ROLE[role];

  try {
    createSession(
      sessionId,
      { type: trigger.type, source: trigger.source },
      { agentRole: role, intentRaw: options.intentRaw ?? null },
    );
  } catch (dbErr) {
    throw new Error(`Failed to create session record: ${dbErr.message}`);
  }

  const memory       = memoryManager.loadMemory();
  const skillIndex   = skillStore.listCompact();
  const systemPrompt = contextBuilder.build({ memory, skillIndex, role });
  const tools        = toolRegistry.getSchemas(role);

  try {
    saveTurn(sessionId, 'user', trigger.message, null, null);
  } catch (dbErr) {
    // Close the orphaned session row before propagating.
    try { closeSession(sessionId, 'error: failed to persist user turn'); } catch { /* ignore */ }
    throw new Error(`Failed to persist user turn: ${dbErr.message}`);
  }

  return new Promise((resolve, reject) => {
    // ── Build per-session SAM instance ──────────────────────────────────────
    const samInst = createInstance({ instanceName: `session-${sessionId}` });
    const samApi  = api(samInst);

    // ── Initial model state ──────────────────────────────────────────────────
    const initialMessages = [{ role: 'user', content: trigger.message }];

    samApi.addInitialState({
      sessionId,
      systemPrompt,
      tools,
      apiKey:           env.anthropicApiKey,
      triggerType:      trigger.type,
      agentRole:        role,
      model:            resolvedModel,
      maxTokens:        resolvedTokens,
      maxIterations:    resolvedMaxIter,
      messages:         initialMessages,
      iterations:       0,
      pendingToolCalls: [],
      toolResults:      [],
      processingIndex:  0,
      status:           'running',
      finalText:        '',
    });

    // ── Acceptors ────────────────────────────────────────────────────────────
    // Both makeReactor() and makeCompressionAcceptor() are called per-session
    // so each session gets its own independent instance with no shared state.
    samApi.addAcceptors([
      iterationGuardAcceptor,
      contextCompressor.makeCompressionAcceptor(),
      claudeResponseAcceptor,
      toolResultAcceptor,
      makeReactor(),
    ]);

    // ── Wire up intents before NAPs reference them ───────────────────────────
    const { intents: [callClaudeIntent, processToolIntent] } = samApi.getIntents([
      callClaudeAction,
      processToolAction,
    ]);

    // ── NAPs ─────────────────────────────────────────────────────────────────
    samApi.addNAPs([
      makeProcessToolNap(processToolIntent),
      makeCallClaudeNap(callClaudeIntent),
    ]);

    // ── Render: resolve/reject Promise on terminal states ───────────────────
    let sessionClosed = false;

    samApi.setRender(model => {
      if (model.status === 'complete' && !sessionClosed) {
        sessionClosed = true;
        closeSession(sessionId, model.finalText.slice(0, 500));

        // Fire post-session hook asynchronously — do not block the response.
        const toolCalls = getSessionToolCalls(sessionId);
        postSessionHook({
          sessionId,
          trigger,
          toolCalls,
          finalText: model.finalText,
          status:    'complete',
        }).catch(() => { /* errors already logged inside hook */ });

        resolve({ session_id: sessionId, response: model.finalText });

      } else if (model.status === 'error' && !sessionClosed) {
        // The session-fsm reactor can set status='error' on an illegal FSM
        // transition.  Without this branch the outer Promise never settles and
        // closeSession is never called, leaking the session row and hanging the
        // caller indefinitely.
        sessionClosed = true;
        const errMsg  = model.errorMessage ?? 'Session FSM error';
        closeSession(sessionId, `error: ${errMsg.slice(0, 494)}`);

        postSessionHook({
          sessionId,
          trigger,
          toolCalls: [],
          finalText: errMsg,
          status:    'error',
        }).catch(() => { /* errors already logged inside hook */ });

        reject(new Error(errMsg));
      }
    });

    // ── Kick off the first Claude call ───────────────────────────────────────
    // Use the same initialMessages reference set on the model so there is a
    // single source of truth for the opening conversation turn.
    callClaudeIntent({
      messages:     initialMessages,
      systemPrompt,
      tools,
      apiKey:       env.anthropicApiKey,
      sessionId,
      model:        resolvedModel,
      maxTokens:    resolvedTokens,
    }).catch(err => {
      if (!sessionClosed) {
        sessionClosed = true;
        closeSession(sessionId, `Error: ${err.message}`);
        reject(err);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  runSession,
  // Exposed for unit testing of the role-routing tables.
  deriveRole,
  MODEL_BY_ROLE,
  MAX_TOKENS_BY_ROLE,
  MAX_ITER_BY_ROLE,
  // Exposed for unit testing of the execution-time role gate.
  processToolUse,
};
