'use strict';

const Anthropic    = require('@anthropic-ai/sdk');
const yaml         = require('js-yaml');
const { getConfig }           = require('../config/cosa.config');
const memoryManager           = require('./memory-manager');
const skillStore              = require('./skill-store');
const { createSkillCreationFSM } = require('./skill-creation-fsm');
const { createLogger } = require('./logger');

const log = createLogger('post-session-hook');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum executed tool calls in a session before skill creation is considered. */
const DEFAULT_MIN_TOOL_CALLS_FOR_SKILL = 3;

/** Claude model used to generate skill documents. */
const SKILL_GEN_MODEL = 'claude-sonnet-4-6';

/** Max tokens for skill generation response. */
const SKILL_GEN_MAX_TOKENS = 1024;

// ---------------------------------------------------------------------------
// Memory update helpers
// ---------------------------------------------------------------------------

/**
 * Build a memory patch from a `health_check` tool output.
 *
 * AC2: healthy status → update applianceHealth only.
 * AC3: degraded/unreachable → update applianceHealth and activeAnomalies.
 *
 * @param {object} result - Parsed health_check tool output.
 * @returns {object} Partial memory patch.
 */
function _healthCheckPatch(result) {
  const { overall_status, checked_at, errors = [] } = result;
  const patch = {
    applianceHealth: `Status: ${overall_status} — last checked ${checked_at}`,
  };

  if (overall_status === 'degraded' || overall_status === 'unreachable') {
    const errSummary = errors.length > 0 ? errors.join('; ') : overall_status;
    patch.activeAnomalies = `${overall_status.toUpperCase()} as of ${checked_at}: ${errSummary}`;
  }

  return patch;
}

/**
 * Build a memory patch from a `backup_run` tool output.
 *
 * AC4: success → update lastBackup only.
 * AC5: failure → update lastBackup and activeAnomalies.
 *
 * @param {object} result - Parsed backup_run tool output.
 * @returns {object} Partial memory patch.
 */
function _backupRunPatch(result) {
  const { success, backup_path, row_count, completed_at, error } = result;

  if (success) {
    return {
      lastBackup: `${completed_at}: ${row_count} rows → ${backup_path}`,
    };
  }

  return {
    lastBackup:     `${completed_at ?? new Date().toISOString()}: FAILED — ${error ?? 'unknown error'}`,
    activeAnomalies: `Backup failed: ${error ?? 'unknown error'}`,
  };
}

/**
 * Scan `toolCalls` for health_check and backup_run results and apply any
 * relevant patches to MEMORY.md.
 *
 * @param {Array<{ tool_name: string, output: object|null }>} toolCalls
 */
function _updateMemoryFromToolCalls(toolCalls) {
  const combinedPatch = {};

  for (const tc of toolCalls) {
    if (!tc.output) continue;

    if (tc.tool_name === 'health_check') {
      Object.assign(combinedPatch, _healthCheckPatch(tc.output));
    } else if (tc.tool_name === 'backup_run') {
      Object.assign(combinedPatch, _backupRunPatch(tc.output));
    }
  }

  if (Object.keys(combinedPatch).length > 0) {
    memoryManager.updateMemory(combinedPatch);
    log.info(`Memory updated: ${Object.keys(combinedPatch).join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// Skill creation helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether a new skill should be generated for this session.
 *
 * AC6:
 *   - trigger_type is not 'email'
 *   - executed tool call count meets the configured minimum
 *   - session completed successfully (status === 'complete')
 *
 * @param {string} triggerType
 * @param {number} toolCallCount
 * @param {string} status
 * @returns {boolean}
 */
function shouldCreateSkill(triggerType, toolCallCount, status) {
  const { appliance } = getConfig();
  const minCalls = appliance.tools?.post_session_hook?.min_tool_calls_for_skill
    ?? DEFAULT_MIN_TOOL_CALLS_FOR_SKILL;

  return (
    triggerType !== 'email' &&
    toolCallCount >= minCalls   &&
    status       === 'complete'
  );
}

/**
 * Build an FTS5-compatible search query from the tool names used in the
 * session.  A skill mentioning any of these tools is considered a match.
 *
 * @param {Array<{ tool_name: string }>} toolCalls
 * @returns {string}
 */
function _buildSkillSearchQuery(toolCalls) {
  const uniqueNames = [...new Set(toolCalls.map(tc => tc.tool_name))];
  // Convert snake_case tool names to space-separated words for FTS5 tokeniser.
  return uniqueNames
    .map(n => n.replace(/_/g, ' '))
    .join(' OR ');
}

/**
 * Build the Claude prompt for skill generation.
 *
 * @param {Array<{ tool_name: string }>} toolCalls
 * @param {string} finalText
 * @returns {string}
 */
function _buildSkillGenPrompt(toolCalls, finalText) {
  const toolNames = [...new Set(toolCalls.map(tc => tc.tool_name))].join(', ');
  return [
    'You are a technical documentation writer for the COSA appliance agent framework.',
    'Generate a new reusable skill document in agentskills.io format based on the',
    'session summary below.',
    '',
    `Tools used in this session: ${toolNames}`,
    '',
    "Agent's final response (truncated):",
    finalText.slice(0, 800),
    '',
    'Output ONLY a Markdown document with the following structure — no preamble, no trailing text:',
    '',
    '---',
    'name: <kebab-case-unique-skill-name>',
    'title: <Human Readable Title>',
    'description: <One-line description of what this skill accomplishes>',
    'domain: <one of: monitoring, backup, diagnostics, maintenance, configuration, reporting>',
    '---',
    '',
    '## Steps',
    '',
    '<numbered steps generalising the pattern used in this session>',
    '',
    '## Experience',
    '',
  ].join('\n');
}

/**
 * Call Claude Sonnet to generate a raw skill document string.
 * Returns the raw markdown text, or null on API failure.
 *
 * This is the **generation** step.  Parsing / validation is a separate step
 * so that the SkillCreationFSM can properly transition generating→validating.
 *
 * @param {Array<{ tool_name: string }>} toolCalls
 * @param {string} finalText
 * @param {string} apiKey
 * @returns {Promise<string|null>}
 */
async function _callClaudeForSkillRaw(toolCalls, finalText, apiKey) {
  const prompt = _buildSkillGenPrompt(toolCalls, finalText);
  try {
    const client   = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model:      SKILL_GEN_MODEL,
      max_tokens: SKILL_GEN_MAX_TOKENS,
      messages:   [{ role: 'user', content: prompt }],
    });
    return response.content.find(b => b.type === 'text')?.text ?? null;
  } catch (err) {
    log.error(`Skill generation API call failed: ${err.message}`);
    return null;
  }
}

/**
 * Parse an agentskills.io markdown document into its component fields.
 *
 * @param {string} raw
 * @returns {{
 *   name:        string,
 *   title:       string,
 *   description: string,
 *   domain:      string,
 *   content:     string,
 * }|null}  null if frontmatter is missing or required fields are absent.
 */
function _parseSkillDocument(raw) {
  const match = raw.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    log.warn('Skill generation response missing frontmatter block');
    return null;
  }

  let frontmatter;
  try {
    frontmatter = yaml.load(match[1]);
  } catch (err) {
    log.warn(`Skill frontmatter YAML parse error: ${err.message}`);
    return null;
  }

  const { name, title, description, domain } = frontmatter ?? {};
  if (!name || !title || !description || !domain) {
    log.warn('Skill frontmatter missing required fields');
    return null;
  }

  return { name, title, description, domain, content: raw.trim() };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the post-session hook: update MEMORY.md from tool call results and
 * optionally generate a new skill if this session represents a novel
 * problem-solving pattern.
 *
 * This function is designed to be called fire-and-forget after session close.
 * All errors are caught and logged rather than propagated.
 *
 * AC1: called with sessionId, trigger, toolCalls, finalText.
 *
 * @param {{
 *   sessionId:  string,
 *   trigger:    { type: string, source: string },
 *   toolCalls:  Array<{ tool_name: string, output: object|null }>,
 *   finalText:  string,
 *   status?:    string,
 * }} params
 */
async function postSessionHook({ sessionId, trigger, toolCalls, finalText, status = 'complete' }) {
  try {
    // ── AC2–5: Update MEMORY.md from health_check and backup_run results ────
    _updateMemoryFromToolCalls(toolCalls);
  } catch (err) {
    log.error(`Memory update failed for session ${sessionId}: ${err.message}`);
  }

  // ── AC6–8: Skill creation via SkillCreationFSM ──────────────────────────
  // Each attempt gets its own FSM instance — no shared state between sessions.
  const fsm = createSkillCreationFSM();

  try {
    // idle → evaluating
    fsm.send('post_session_hook');

    if (!shouldCreateSkill(trigger.type, toolCalls.length, status)) {
      fsm.send('not_novel'); // evaluating → idle
      return;
    }

    // evaluating → searching
    fsm.send('novel_detected');
    const { env }     = getConfig();
    const searchQuery = _buildSkillSearchQuery(toolCalls);
    const existing    = searchQuery ? skillStore.searchSkills(searchQuery, 1) : [];

    if (existing.length > 0) {
      log.info(`Skill already exists for pattern '${searchQuery}' — skipping creation`);
      fsm.send('match_found'); // searching → idle (existing skill; flag for improvement)
      return;
    }

    // searching → generating
    fsm.send('no_match');
    log.info(`Generating new skill for session ${sessionId} (tools: ${searchQuery})`);

    // Retry loop: up to 2 validation attempts (AC5/AC6 of Story 16).
    const MAX_RETRIES = 2;
    let   retries     = 0;

    while (retries < MAX_RETRIES) {
      // ── Generation step (generating state) ─────────────────────────────────
      const rawText = await _callClaudeForSkillRaw(toolCalls, finalText, env.anthropicApiKey);

      if (!rawText) {
        // API failure — treat as a failed validation attempt so the retry
        // logic runs, but do not advance FSM to 'validating' (generation did
        // not complete).
        retries++;
        if (retries >= MAX_RETRIES) {
          fsm.send('retry_exceeded'); // generating → idle
          log.warn(`Skill creation for session ${sessionId}: max retries exceeded (API failure), no skill saved`);
          return;
        }
        log.info(`Skill generation returned no text (attempt ${retries}/${MAX_RETRIES}), retrying`);
        continue;
      }

      // generating → validating
      fsm.send('generated');

      // ── Validation step (validating state) ─────────────────────────────────
      const skillDoc = _parseSkillDocument(rawText);

      if (skillDoc) {
        // validating → persisted
        fsm.send('valid');

        // Guard against a duplicate name created between search and insert.
        if (!skillStore.get(skillDoc.name)) {
          skillStore.create(skillDoc);
          log.info(`New skill created: '${skillDoc.name}' (${skillDoc.domain})`);
        } else {
          log.info(`Skill '${skillDoc.name}' already exists — skipping insert`);
        }

        fsm.send('reset'); // persisted → idle
        return;
      }

      // Validation failed.
      retries++;
      if (retries >= MAX_RETRIES) {
        fsm.send('retry_exceeded'); // validating → idle
        log.warn(`Skill creation for session ${sessionId}: max retries exceeded, no skill saved`);
        return;
      }

      fsm.send('invalid'); // validating → generating (retry)
      log.info(`Skill validation failed (attempt ${retries}/${MAX_RETRIES}), retrying generation`);
    }
  } catch (err) {
    log.error(`Skill creation failed for session ${sessionId}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { postSessionHook, shouldCreateSkill };
