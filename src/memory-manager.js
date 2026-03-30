'use strict';

const path = require('path');
const fs   = require('fs');
const { getConfig } = require('../config/cosa.config');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard character limit for MEMORY.md. Never exceeded after any write. */
const MAX_CHARS = 2200;

/** Target incident count when pruning is needed. */
const INCIDENT_PRUNE_TARGET = 3;

/** Notes section is truncated to this many characters when over limit after incident prune. */
const NOTES_TRUNCATE_CHARS = 100;

/** Ordered list of section names as they appear in MEMORY.md. */
const SECTION_ORDER = [
  'Appliance Health',
  'Recent Incidents',
  'Active Anomalies',
  'Operator Preferences',
  'Last Backup',
  'Notes',
];

/** Mapping from patch key → section name. */
const PATCH_KEY_TO_SECTION = {
  applianceHealth:    'Appliance Health',
  activeAnomalies:    'Active Anomalies',
  operatorPreference: 'Operator Preferences',
  lastBackup:         'Last Backup',
  notes:              'Notes',
};

// ---------------------------------------------------------------------------
// Path helper
// ---------------------------------------------------------------------------

/**
 * Return the absolute path to MEMORY.md, derived from the configured dataDir.
 *
 * @returns {string}
 */
function _memoryPath() {
  const { env } = getConfig();
  return path.resolve(process.cwd(), env.dataDir, 'MEMORY.md');
}

// ---------------------------------------------------------------------------
// Empty template
// ---------------------------------------------------------------------------

/**
 * Build the empty MEMORY.md template stamped with `timestamp`.
 *
 * @param {string} timestamp - ISO 8601 string.
 * @returns {string}
 */
function _emptyTemplate(timestamp) {
  return [
    `<!-- COSA MEMORY — last updated: ${timestamp} -->`,
    '',
    '## Appliance Health',
    'No data yet.',
    '',
    '## Recent Incidents',
    '(none)',
    '',
    '## Active Anomalies',
    'None.',
    '',
    '## Operator Preferences',
    'None recorded.',
    '',
    '## Last Backup',
    'No backup recorded.',
    '',
    '## Notes',
    '',
    '<!-- END MEMORY -->',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Section parsing and reassembly
// ---------------------------------------------------------------------------

/**
 * Parse MEMORY.md content into its component sections.
 *
 * @param {string} content
 * @returns {{ sections: Record<string, string> }}
 *   `sections` maps section name → trimmed body text.
 */
function _parseSections(content) {
  const sections = {};
  let currentName = null;
  let currentLines = [];

  for (const line of content.split('\n')) {
    if (line.startsWith('## ')) {
      if (currentName !== null) {
        sections[currentName] = currentLines.join('\n').trim();
      }
      currentName = line.slice(3).trim();
      currentLines = [];
    } else if (line.startsWith('<!-- END MEMORY -->')) {
      if (currentName !== null) {
        sections[currentName] = currentLines.join('\n').trim();
        currentName = null;
      }
    } else if (currentName !== null) {
      currentLines.push(line);
    }
  }

  return { sections };
}

/**
 * Reassemble sections into a MEMORY.md string, updating the timestamp header.
 *
 * @param {Record<string, string>} sections
 * @param {string} timestamp
 * @returns {string}
 */
function _buildDocument(sections, timestamp) {
  const parts = [`<!-- COSA MEMORY — last updated: ${timestamp} -->`, ''];

  for (const name of SECTION_ORDER) {
    parts.push(`## ${name}`);
    parts.push(sections[name] ?? '');
    parts.push('');
  }

  parts.push('<!-- END MEMORY -->');
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Limit enforcement helpers
// ---------------------------------------------------------------------------

/**
 * Prune the Recent Incidents section to `target` entries, removing oldest
 * (bottom-most) bullet lines first.
 *
 * @param {Record<string, string>} sections - Mutated in place.
 * @param {number} target - Maximum number of entries to retain.
 * @returns {Record<string, string>} The same `sections` reference.
 */
function _pruneIncidents(sections, target) {
  const body    = sections['Recent Incidents'] ?? '';
  const entries = body.split('\n').filter(l => l.trimStart().startsWith('-'));

  if (entries.length <= target) return sections;

  // Keep the `target` most recent entries (the ones at the top of the list).
  sections['Recent Incidents'] = entries.slice(0, target).join('\n');
  return sections;
}

/**
 * Truncate the Notes section body to `maxChars` characters.
 *
 * @param {Record<string, string>} sections - Mutated in place.
 * @param {number} maxChars
 * @returns {Record<string, string>}
 */
function _truncateNotes(sections, maxChars) {
  const body = sections['Notes'] ?? '';
  if (body.length > maxChars) {
    sections['Notes'] = body.slice(0, maxChars);
  }
  return sections;
}

/**
 * Enforce the 2200-character hard limit on an assembled document.
 *
 * Pass 1 — prune Recent Incidents to {@link INCIDENT_PRUNE_TARGET} entries.
 * Pass 2 — truncate Notes to {@link NOTES_TRUNCATE_CHARS} characters.
 * Pass 3 — clear Notes entirely if still over limit.
 * Pass 4 — hard-slice the raw document as an absolute last resort so the
 *           invariant `doc.length ≤ MAX_CHARS` is **always** satisfied,
 *           even when other sections are pathologically large.
 *
 * @param {Record<string, string>} sections
 * @param {string} timestamp
 * @returns {string} Final MEMORY.md string ≤ MAX_CHARS.
 */
function _enforceLimit(sections, timestamp) {
  let doc = _buildDocument(sections, timestamp);
  if (doc.length <= MAX_CHARS) return doc;

  // Pass 1: prune incidents.
  _pruneIncidents(sections, INCIDENT_PRUNE_TARGET);
  doc = _buildDocument(sections, timestamp);
  if (doc.length <= MAX_CHARS) return doc;

  // Pass 2: truncate Notes to 100 chars.
  _truncateNotes(sections, NOTES_TRUNCATE_CHARS);
  doc = _buildDocument(sections, timestamp);
  if (doc.length <= MAX_CHARS) return doc;

  // Pass 3: clear Notes entirely.
  sections['Notes'] = '';
  doc = _buildDocument(sections, timestamp);
  if (doc.length <= MAX_CHARS) return doc;

  // Pass 4: hard-slice — other sections are pathologically large.
  // Truncate at MAX_CHARS so the file is never written over the limit.
  return doc.slice(0, MAX_CHARS);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load MEMORY.md from disk.
 * Returns the empty template if the file does not exist.
 *
 * @returns {string} Full contents of MEMORY.md (≤2200 chars guaranteed on any
 *   file written by this module).
 */
function loadMemory() {
  const filePath = _memoryPath();
  if (!fs.existsSync(filePath)) {
    return _emptyTemplate(new Date().toISOString());
  }
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * Replace MEMORY.md entirely with `content` after enforcing the character
 * limit.  Used when the orchestrator generates a full memory rewrite.
 *
 * If `content` exceeds {@link MAX_CHARS}, the Recent Incidents section is
 * pruned first, then Notes is truncated.
 *
 * @param {string} content
 * @throws {Error} if `content` is not a string.
 */
function writeMemory(content) {
  if (typeof content !== 'string') throw new Error('writeMemory: content must be a string');

  const timestamp = new Date().toISOString();
  let final = content;

  if (final.length > MAX_CHARS) {
    const { sections } = _parseSections(final);
    final = _enforceLimit(sections, timestamp);
  }

  const filePath = _memoryPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, final, 'utf8');
}

/**
 * Merge a patch object into the current MEMORY.md sections and write back.
 *
 * **Implemented as a SAM acceptor** per Phase 2 §19.4: the merge + limit check
 * is performed before any filesystem write, so the 2200-char invariant is
 * enforced at the model level.
 *
 * Patch keys:
 * - `applianceHealth`    — replaces the "Appliance Health" section body
 * - `recentIncident`     — `{ date, event, resolution }` prepended as a bullet
 * - `activeAnomalies`    — replaces the "Active Anomalies" section body
 * - `operatorPreference` — replaces the "Operator Preferences" section body
 * - `lastBackup`         — replaces the "Last Backup" section body
 * - `notes`              — replaces the "Notes" section body
 *
 * @param {{
 *   applianceHealth?:    string,
 *   recentIncident?:     { date: string, event: string, resolution: string },
 *   activeAnomalies?:    string,
 *   operatorPreference?: string,
 *   lastBackup?:         string,
 *   notes?:              string,
 * }} patch
 */
function updateMemory(patch) {
  const timestamp         = new Date().toISOString();
  const current           = loadMemory();
  const { sections }      = _parseSections(current);

  // ── Apply simple field replacements ────────────────────────────────────────
  for (const [patchKey, sectionName] of Object.entries(PATCH_KEY_TO_SECTION)) {
    if (patch[patchKey] != null) {
      sections[sectionName] = String(patch[patchKey]);
    }
  }

  // ── Prepend new incident bullet ────────────────────────────────────────────
  if (patch.recentIncident != null) {
    const { date, event, resolution } = patch.recentIncident;
    const newBullet = `- ${date}: ${event} — ${resolution}`;
    const existing  = sections['Recent Incidents'] ?? '';

    // Strip placeholder "(none)" if present.
    const cleaned = existing === '(none)' || existing === '' ? '' : existing;
    sections['Recent Incidents'] = cleaned
      ? `${newBullet}\n${cleaned}`
      : newBullet;
  }

  // ── Enforce limit and write ────────────────────────────────────────────────
  const final = _enforceLimit(sections, timestamp);

  const filePath = _memoryPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, final, 'utf8');
}

// ---------------------------------------------------------------------------
// SAM acceptor factory  (Phase 2 §19.4)
// ---------------------------------------------------------------------------

/**
 * Return a SAM-pattern acceptor that merges a memory patch into the session
 * model and writes MEMORY.md to disk.
 *
 * The acceptor fires when the proposal contains a `memoryPatch` field.
 * It enforces the 2200-char hard limit before mutating `model.memory` or
 * touching the filesystem — consistent with the SAM rule that acceptors
 * decide whether (and how) a proposal is accepted into the model.
 *
 * Usage:
 * ```js
 * samApi.addAcceptors([ memoryManager.makeMemoryAcceptor() ]);
 * ```
 *
 * @returns {(model: object) => (proposal: object) => void}
 */
function makeMemoryAcceptor() {
  return model => proposal => {
    if (proposal.memoryPatch == null) return;

    const timestamp    = new Date().toISOString();
    const base         = model.memory ?? loadMemory();
    const { sections } = _parseSections(base);

    // Apply patch fields (same logic as updateMemory).
    for (const [patchKey, sectionName] of Object.entries(PATCH_KEY_TO_SECTION)) {
      if (proposal.memoryPatch[patchKey] != null) {
        sections[sectionName] = String(proposal.memoryPatch[patchKey]);
      }
    }

    if (proposal.memoryPatch.recentIncident != null) {
      const { date, event, resolution } = proposal.memoryPatch.recentIncident;
      const newBullet = `- ${date}: ${event} — ${resolution}`;
      const existing  = sections['Recent Incidents'] ?? '';
      const cleaned   = existing === '(none)' || existing === '' ? '' : existing;
      sections['Recent Incidents'] = cleaned
        ? `${newBullet}\n${cleaned}`
        : newBullet;
    }

    const final = _enforceLimit(sections, timestamp);

    // Mutate the model's memory snapshot.
    model.memory = final;

    // Write to disk (model mutation step in SAM).
    const filePath = _memoryPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, final, 'utf8');
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  loadMemory,
  updateMemory,
  writeMemory,
  makeMemoryAcceptor,
  // Exported for testing
  _emptyTemplate,
  _parseSections,
  _buildDocument,
  _enforceLimit,
};
