'use strict';

const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');
const yaml     = require('js-yaml');
const { getConfig } = require('../config/cosa.config');

/** Absolute path to the seed skills directory. */
const SEED_DIR = path.resolve(__dirname, '../skills/seed');

/** Max document length (chars) before Experience trimming kicks in. */
const MAX_CONTENT_CHARS = 3000;

/** Number of Experience entries to keep when trimming. */
const MAX_EXPERIENCE_ENTRIES = 5;

/** @type {import('better-sqlite3').Database | null} */
let _db = null;

/**
 * DDL statements executed in order during migration.
 * Each entry is idempotent (uses IF NOT EXISTS).
 * @type {string[]}
 */
const MIGRATIONS = [
  // ── Core skills table ──────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS skills (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL UNIQUE,
    title        TEXT    NOT NULL,
    description  TEXT    NOT NULL,
    domain       TEXT    NOT NULL,
    content      TEXT    NOT NULL,
    version      INTEGER NOT NULL DEFAULT 1,
    use_count    INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    created_at   TEXT    NOT NULL,
    updated_at   TEXT    NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_skills_domain    ON skills(domain)`,
  `CREATE INDEX IF NOT EXISTS idx_skills_use_count ON skills(use_count)`,

  // ── FTS5 virtual table — indexes name, title, description; domain is stored
  //    but not tokenised (used for filtering); content read from skills table ──
  `CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
    name,
    title,
    description,
    domain UNINDEXED,
    content=skills,
    content_rowid=id
  )`,

  // ── FTS5 sync triggers ─────────────────────────────────────────────────────
  `CREATE TRIGGER IF NOT EXISTS skills_fts_insert AFTER INSERT ON skills BEGIN
     INSERT INTO skills_fts(rowid, name, title, description, domain)
     VALUES (new.id, new.name, new.title, new.description, new.domain);
   END`,

  `CREATE TRIGGER IF NOT EXISTS skills_fts_delete AFTER DELETE ON skills BEGIN
     INSERT INTO skills_fts(skills_fts, rowid, name, title, description, domain)
     VALUES ('delete', old.id, old.name, old.title, old.description, old.domain);
   END`,

  `CREATE TRIGGER IF NOT EXISTS skills_fts_update AFTER UPDATE ON skills BEGIN
     INSERT INTO skills_fts(skills_fts, rowid, name, title, description, domain)
     VALUES ('delete', old.id, old.name, old.title, old.description, old.domain);
     INSERT INTO skills_fts(rowid, name, title, description, domain)
     VALUES (new.id, new.name, new.title, new.description, new.domain);
   END`,

  // ── Skill usage log ────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS skill_uses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id    INTEGER NOT NULL REFERENCES skills(id),
    session_id  TEXT,
    invoked_at  TEXT    NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_skill_uses_skill_id   ON skill_uses(skill_id)`,
  `CREATE INDEX IF NOT EXISTS idx_skill_uses_session_id ON skill_uses(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_skill_uses_invoked_at ON skill_uses(invoked_at)`,
];

// ---------------------------------------------------------------------------
// Connection management
// ---------------------------------------------------------------------------

/**
 * Open (or reuse) the skills.db connection and return it.
 *
 * @returns {import('better-sqlite3').Database}
 */
function getDb() {
  if (_db !== null) return _db;

  const { env } = getConfig();
  const dbDir = path.resolve(process.cwd(), env.dataDir);
  fs.mkdirSync(dbDir, { recursive: true });

  const dbPath = path.join(dbDir, 'skills.db');
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  return _db;
}

/**
 * Run all schema migrations against skills.db.
 * Safe to call on every startup — all statements are idempotent.
 *
 * @throws {Error} if any migration statement fails.
 */
function runMigrations() {
  const db = getDb();
  const migrate = db.transaction(() => {
    for (const sql of MIGRATIONS) {
      db.exec(sql);
    }
  });
  migrate();
}

/**
 * Close the database connection.
 * **For use in tests and graceful shutdown only.**
 */
function closeDb() {
  if (_db !== null) {
    _db.close();
    _db = null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @returns {string} Current time as ISO 8601 string. */
function now() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// CRUD — Skills
// ---------------------------------------------------------------------------

/**
 * Insert a new skill.
 *
 * @param {{
 *   name:        string,
 *   title:       string,
 *   description: string,
 *   domain:      string,
 *   content:     string,
 *   version?:    number
 * }} skill
 * @returns {number} The inserted row id.
 */
function createSkill(skill) {
  const ts = now();
  const info = getDb()
    .prepare(
      `INSERT INTO skills
         (name, title, description, domain, content, version, use_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
    )
    .run(
      skill.name,
      skill.title,
      skill.description,
      skill.domain,
      skill.content,
      skill.version ?? 1,
      ts,
      ts
    );
  return info.lastInsertRowid;
}

/**
 * Look up a skill by its unique name.
 *
 * @param {string} name
 * @returns {object|undefined} The matching row, or undefined if not found.
 */
function findSkillByName(name) {
  return getDb()
    .prepare(`SELECT * FROM skills WHERE name = ?`)
    .get(name);
}

/**
 * Update a skill's content and bump its version number.
 *
 * @param {string} name - Skill name (primary lookup key).
 * @param {{ title?: string, description?: string, domain?: string, content?: string }} updates
 */
function updateSkill(name, updates) {
  const existing = findSkillByName(name);
  if (!existing) throw new Error(`Skill not found: ${name}`);

  getDb()
    .prepare(
      `UPDATE skills
       SET title       = ?,
           description = ?,
           domain      = ?,
           content     = ?,
           version     = version + 1,
           updated_at  = ?
       WHERE name = ?`
    )
    .run(
      updates.title       ?? existing.title,
      updates.description ?? existing.description,
      updates.domain      ?? existing.domain,
      updates.content     ?? existing.content,
      now(),
      name
    );
}

// ---------------------------------------------------------------------------
// CRUD — Skill Uses
// ---------------------------------------------------------------------------

/**
 * Record an invocation of a skill and increment its use_count.
 *
 * @param {number} skillId - The `id` of the skill row.
 * @param {string|null} sessionId - The session that invoked the skill, or null.
 * @returns {number} The inserted skill_uses row id.
 */
function recordSkillUse(skillId, sessionId) {
  const ts = now();
  const db = getDb();

  db.prepare(
    `UPDATE skills SET use_count = use_count + 1, last_used_at = ? WHERE id = ?`
  ).run(ts, skillId);

  const info = db
    .prepare(
      `INSERT INTO skill_uses (skill_id, session_id, invoked_at) VALUES (?, ?, ?)`
    )
    .run(skillId, sessionId ?? null, ts);

  return info.lastInsertRowid;
}

// ---------------------------------------------------------------------------
// Public CRUD API
// ---------------------------------------------------------------------------

/**
 * Return all skills as an array of full row objects.
 *
 * @returns {object[]}
 */
function list() {
  return getDb()
    .prepare(`SELECT * FROM skills ORDER BY domain, name`)
    .all();
}

/**
 * Return a compact representation of all skills suitable for inclusion in a
 * system prompt (~30 tokens per skill).
 *
 * Format per line: `<name> (<domain>): <description>`
 *
 * @returns {string}
 */
function listCompact() {
  const rows = getDb()
    .prepare(`SELECT name, domain, description FROM skills ORDER BY domain, name`)
    .all();
  if (rows.length === 0) return '(no skills installed)';
  return rows
    .map(r => `${r.name} (${r.domain}): ${r.description}`)
    .join('\n');
}

/**
 * Return the full skill document for `name`, or null if not found.
 *
 * @param {string} name
 * @returns {object|null}
 */
function get(name) {
  return getDb()
    .prepare(`SELECT * FROM skills WHERE name = ?`)
    .get(name) ?? null;
}

/**
 * Insert a new skill and return the full inserted row.
 *
 * @param {{
 *   name:        string,
 *   title:       string,
 *   description: string,
 *   domain:      string,
 *   content:     string,
 *   version?:    number
 * }} skill
 * @returns {object} The newly inserted row.
 */
function create(skill) {
  const id = createSkill(skill);
  return getDb()
    .prepare(`SELECT * FROM skills WHERE id = ?`)
    .get(id);
}

/**
 * Append an experience entry to a skill's `## Experience` section.
 *
 * The entry is prepended with an ISO timestamp.  If the resulting document
 * exceeds {@link MAX_CONTENT_CHARS} characters, the Experience section is
 * trimmed to the {@link MAX_EXPERIENCE_ENTRIES} most recent entries.
 *
 * @param {string} name - Skill name.
 * @param {string} experience - Plain-text description of the experience.
 * @throws {Error} if the skill does not exist.
 */
function improve(name, experience) {
  const skill = get(name);
  if (!skill) throw new Error(`Skill not found: ${name}`);

  const entry   = `- [${now()}] ${experience}`;
  const content = _appendExperience(skill.content, entry);

  getDb()
    .prepare(
      `UPDATE skills
       SET content    = ?,
           version    = version + 1,
           updated_at = ?
       WHERE name = ?`
    )
    .run(content, now(), name);
}

// ---------------------------------------------------------------------------
// Experience helpers
// ---------------------------------------------------------------------------

/**
 * Append `entry` to the `## Experience` section of `content`.
 * If the section is absent it is created at the end of the document.
 * The entry is inserted at the end of the Experience section, before any
 * subsequent `## ` heading, so that later sections are not displaced.
 * Trims to MAX_EXPERIENCE_ENTRIES if the result exceeds MAX_CONTENT_CHARS.
 *
 * @param {string} content
 * @param {string} entry
 * @returns {string} Updated content string.
 */
function _appendExperience(content, entry) {
  const sectionHeader = '## Experience';

  let updated;
  const idx = content.indexOf(sectionHeader);
  if (idx !== -1) {
    // Find where the Experience section ends — i.e. the start of the next
    // `## ` heading (if any) or the end of the document.
    const afterHeader = idx + sectionHeader.length;
    const nextSection = content.indexOf('\n## ', afterHeader);
    if (nextSection !== -1) {
      // Insert before the next heading, preserving sections that follow.
      updated =
        content.slice(0, nextSection).trimEnd() +
        '\n' + entry + '\n' +
        content.slice(nextSection);
    } else {
      // Experience is the last section — append to document end.
      updated = content.trimEnd() + '\n' + entry + '\n';
    }
  } else {
    updated = content.trimEnd() + '\n\n' + sectionHeader + '\n' + entry + '\n';
  }

  if (updated.length > MAX_CONTENT_CHARS) {
    updated = _trimExperience(updated);
  }

  return updated;
}

/**
 * Keep only the most recent MAX_EXPERIENCE_ENTRIES bullet lines under
 * `## Experience`, discarding older ones.
 *
 * @param {string} content
 * @returns {string}
 */
function _trimExperience(content) {
  const sectionHeader = '## Experience';
  const idx = content.indexOf(sectionHeader);
  if (idx === -1) return content;

  const before = content.slice(0, idx + sectionHeader.length);
  const after  = content.slice(idx + sectionHeader.length);

  // Split on lines that start with '- ' (experience entries).
  const lines   = after.split('\n');
  const entries = lines.filter(l => l.startsWith('- '));
  const kept    = entries.slice(-MAX_EXPERIENCE_ENTRIES);

  return before + '\n' + kept.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Seed install
// ---------------------------------------------------------------------------

/**
 * Parse a skill markdown file that uses YAML frontmatter.
 *
 * Expected format:
 * ```
 * ---
 * name:        skill-name
 * title:       Human Title
 * description: One-line description
 * domain:      domain-name
 * ---
 *
 * <body content>
 * ```
 *
 * @param {string} markdown - Full file contents.
 * @returns {{ name: string, title: string, description: string, domain: string, content: string }}
 * @throws {Error} if frontmatter is missing or required fields are absent.
 */
function _parseSeedFile(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error('Seed skill missing YAML frontmatter');

  const meta    = yaml.load(match[1]);
  const content = match[2].trim();

  for (const field of ['name', 'title', 'description', 'domain']) {
    if (!meta[field]) throw new Error(`Seed skill missing required field: ${field}`);
  }

  return {
    name:        meta.name,
    title:       meta.title,
    description: meta.description,
    domain:      meta.domain,
    content,
  };
}

/**
 * Read all `*.md` files from {@link SEED_DIR} and insert any that are not
 * already present in the database.  Safe to call on every startup.
 *
 * @returns {{ installed: string[], skipped: string[] }}
 */
function installSeedSkills() {
  const installed = [];
  const skipped   = [];

  let files;
  try {
    files = fs.readdirSync(SEED_DIR).filter(f => f.endsWith('.md'));
  } catch {
    // Seed directory absent — nothing to install.
    return { installed, skipped };
  }

  // Parse all seed files first (outside the transaction) so a bad file
  // does not leave the database in a partially-inserted state.
  const parsed = [];
  for (const file of files) {
    const raw  = fs.readFileSync(path.join(SEED_DIR, file), 'utf8');
    parsed.push(_parseSeedFile(raw));
  }

  // Wrap all inserts in a single transaction: all-or-nothing install,
  // faster than one auto-commit per row.
  const installAll = getDb().transaction(() => {
    for (const seed of parsed) {
      if (findSkillByName(seed.name)) {
        skipped.push(seed.name);
      } else {
        createSkill(seed);
        installed.push(seed.name);
      }
    }
  });

  installAll();

  return { installed, skipped };
}

// ---------------------------------------------------------------------------
// FTS5 Search — Skills
// ---------------------------------------------------------------------------

/**
 * Full-text search across skill name, title, and description.
 *
 * Results are ordered by BM25 relevance (best match first).
 *
 * @param {string} query - FTS5 MATCH expression (e.g. `"ssh health"` or `ssh AND health`).
 * @param {number} [limit=20] - Maximum number of results to return.
 * @returns {Array<{
 *   id:          number,
 *   name:        string,
 *   title:       string,
 *   description: string,
 *   domain:      string,
 *   version:     number,
 *   use_count:   number
 * }>}
 */
function searchSkills(query, limit = 20) {
  return getDb()
    .prepare(
      `SELECT s.id,
              s.name,
              s.title,
              s.description,
              s.domain,
              s.version,
              s.use_count
       FROM   skills_fts
       JOIN   skills s ON s.id = skills_fts.rowid
       WHERE  skills_fts MATCH ?
       ORDER  BY bm25(skills_fts)
       LIMIT  ?`
    )
    .all(query, limit);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getDb,
  runMigrations,
  closeDb,
  // Seed install
  installSeedSkills,
  // Public CRUD
  list,
  listCompact,
  get,
  create,
  improve,
  // Lower-level helpers (used internally and in tests)
  createSkill,
  findSkillByName,
  updateSkill,
  // Skill uses
  recordSkillUse,
  // Search
  searchSkills,
};
