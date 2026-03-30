'use strict';

const Anthropic    = require('@anthropic-ai/sdk');
const yaml         = require('js-yaml');
const { getConfig }  = require('../config/cosa.config');
const memoryManager  = require('./memory-manager');
const skillStore     = require('./skill-store');
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
 * Call Claude Sonnet to generate an agentskills.io skill document.
 *
 * The returned object contains the frontmatter fields extracted from the
 * generated YAML header plus the full markdown `content`.
 *
 * @param {Array<{ tool_name: string }>} toolCalls
 * @param {string} finalText - Agent's final response text from the session.
 * @param {string} apiKey
 * @returns {Promise<{
 *   name:        string,
 *   title:       string,
 *   description: string,
 *   domain:      string,
 *   content:     string,
 * }|null>}  null on generation or parse failure.
 */
async function _generateSkillDocument(toolCalls, finalText, apiKey) {
  const toolNames = [...new Set(toolCalls.map(tc => tc.tool_name))].join(', ');
  const truncatedResponse = finalText.slice(0, 800);

  const prompt = [
    'You are a technical documentation writer for the COSA appliance agent framework.',
    'Generate a new reusable skill document in agentskills.io format based on the',
    'session summary below.',
    '',
    `Tools used in this session: ${toolNames}`,
    '',
    "Agent's final response (truncated):",
    truncatedResponse,
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

  try {
    const client   = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model:      SKILL_GEN_MODEL,
      max_tokens: SKILL_GEN_MAX_TOKENS,
      messages:   [{ role: 'user', content: prompt }],
    });

    const rawText = response.content.find(b => b.type === 'text')?.text ?? '';
    return _parseSkillDocument(rawText);
  } catch (err) {
    log.error(`Skill generation failed: ${err.message}`);
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
  const match = raw.match(/^---\n([\s\S]+?)\n---\n([\s\S]*)$/);
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

  // ── AC6–8: Skill creation gate ───────────────────────────────────────────
  if (!shouldCreateSkill(trigger.type, toolCalls.length, status)) {
    return;
  }

  try {
    const { env } = getConfig();

    // AC7: Search skills_fts; skip if a matching skill already exists.
    const searchQuery = _buildSkillSearchQuery(toolCalls);
    const existing    = searchQuery ? skillStore.searchSkills(searchQuery, 1) : [];

    if (existing.length > 0) {
      log.info(`Skill already exists for pattern '${searchQuery}' — skipping creation`);
      return;
    }

    // AC8: Generate skill document via Claude Sonnet.
    log.info(`Generating new skill for session ${sessionId} (tools: ${searchQuery})`);
    const skillDoc = await _generateSkillDocument(toolCalls, finalText, env.anthropicApiKey);

    if (!skillDoc) return;

    // Guard against duplicate name race or prior run creating the same skill.
    if (skillStore.get(skillDoc.name)) {
      log.info(`Skill '${skillDoc.name}' already exists — skipping insert`);
      return;
    }

    skillStore.create(skillDoc);
    log.info(`New skill created: '${skillDoc.name}' (${skillDoc.domain})`);
  } catch (err) {
    log.error(`Skill creation failed for session ${sessionId}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { postSessionHook, shouldCreateSkill };
