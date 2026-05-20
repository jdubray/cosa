'use strict';

const { createInstance, api } = require('@cognitive-fab/sam-pattern');
const { getConfig }           = require('../config/cosa.config');
const { getDb }               = require('./session-store');
const { createLogger }        = require('./logger');

const log = createLogger('asm');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DIMENSIONS = ['health', 'resources', 'application', 'network', 'security'];

/** Staleness thresholds in milliseconds. */
const STALENESS_MS = {
  health:      10 * 60 * 1000,
  resources:   10 * 60 * 1000,
  application: 30 * 60 * 1000,
  network:     60 * 60 * 1000,
  security:    4  * 60 * 60 * 1000,
};

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

const ASM_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS appliance_state (
    appliance_name  TEXT PRIMARY KEY,
    health          TEXT,
    resources       TEXT,
    application     TEXT,
    network         TEXT,
    security        TEXT,
    updated_at      TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS appliance_state_history (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    appliance_name TEXT NOT NULL,
    dimension      TEXT NOT NULL,
    data           TEXT NOT NULL,
    recorded_at    TEXT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_ash_appliance_dim
     ON appliance_state_history(appliance_name, dimension)`,

  `CREATE INDEX IF NOT EXISTS idx_ash_recorded_at
     ON appliance_state_history(recorded_at)`,
];

function runAsmMigrations() {
  const db      = getDb();
  const migrate = db.transaction(() => {
    for (const sql of ASM_MIGRATIONS) {
      db.exec(sql);
    }
  });
  migrate();
}

// ---------------------------------------------------------------------------
// Dimension normalizers
// ---------------------------------------------------------------------------

function normalizeHealth(raw) {
  return {
    overall_status: raw.overall_status ?? null,
    ssh_connected:  raw.ssh_connected  ?? null,
    http_health: raw.http_health
      ? { status_code: raw.http_health.status_code ?? null,
          reachable:   raw.http_health.reachable   ?? false }
      : null,
    http_ready: raw.http_ready
      ? { status_code: raw.http_ready.status_code ?? null,
          reachable:   raw.http_ready.reachable   ?? false }
      : null,
    process: raw.process
      ? { running:        raw.process.running        ?? null,
          uptime_seconds: raw.process.uptime_seconds ?? null,
          restarts:       raw.process.restarts       ?? null }
      : null,
    checked_at: raw.checked_at ?? new Date().toISOString(),
    error: Array.isArray(raw.errors) && raw.errors.length > 0
      ? raw.errors.join('; ')
      : (raw.error ?? null),
  };
}

function normalizeResources(raw) {
  if (raw && raw.skipped) {
    return { skipped: true, checked_at: new Date().toISOString(), error: null };
  }
  return {
    findings_count:    Array.isArray(raw.findings) ? raw.findings.length : null,
    has_violations:    Array.isArray(raw.findings) && raw.findings.length > 0,
    sampled_processes: raw.sampled_processes ?? null,
    summary:           raw.summary ?? null,
    checked_at:        raw.checked_at ?? new Date().toISOString(),
    error:             raw.error ?? null,
  };
}

function normalizeApplication(raw) {
  return {
    active_orders:          raw.active_orders          ?? null,
    db_size_bytes:          raw.db_size_bytes           ?? null,
    online_ordering_paused: raw.online_ordering_paused ?? null,
    bun_version:            raw.bun_version            ?? null,
    checked_at:             raw.checked_at ?? new Date().toISOString(),
    error:                  raw.error ?? null,
  };
}

function normalizeNetwork(raw) {
  return {
    internet_up: raw.internetUp  ?? raw.internet_up  ?? null,
    internet_ip: raw.publicIp    ?? raw.internet_ip   ?? null,
    lan_devices: raw.lan_devices ?? null,
    checked_at:  raw.checkedAt   ?? raw.checked_at   ?? new Date().toISOString(),
    error:       raw.error       ?? null,
  };
}

function normalizeSecurity(raw, existing) {
  const merged = existing
    ? { ...existing }
    : { last_compliance_pass: null, credential_audit_ok: null,
        git_audit_ok: null, checked_at: null, error: null };

  if (raw.source === 'compliance_verify') {
    merged.last_compliance_pass = raw.passed
      ? (raw.checked_at ?? new Date().toISOString())
      : false;
  } else if (raw.source === 'credential_audit') {
    merged.credential_audit_ok = raw.ok ?? null;
  } else if (raw.source === 'git_audit') {
    merged.git_audit_ok = raw.ok ?? null;
  }
  merged.checked_at = raw.checked_at ?? new Date().toISOString();
  merged.error      = raw.error      ?? null;
  return merged;
}

function normalizeDimension(dimension, raw, existing) {
  switch (dimension) {
    case 'health':      return normalizeHealth(raw);
    case 'resources':   return normalizeResources(raw);
    case 'application': return normalizeApplication(raw);
    case 'network':     return normalizeNetwork(raw);
    case 'security':    return normalizeSecurity(raw, existing);
    default: throw new Error(`[asm] Unknown dimension: "${dimension}"`);
  }
}

// ---------------------------------------------------------------------------
// Snapshot / summary builders
// ---------------------------------------------------------------------------

function buildSnapshot(model) {
  return {
    appliance_name:   model.applianceName,
    health:           model.health,
    resources:        model.resources,
    application:      model.application,
    network:          model.network,
    security:         model.security,
    stale_dimensions: model._staleDimensions ?? [],
    updated_at:       model._updatedAt,
  };
}

/** Format an age in seconds as a human-readable relative label. */
function _ageLabel(checkedAt) {
  if (!checkedAt) return 'never';
  const ageSec = Math.floor((Date.now() - new Date(checkedAt).getTime()) / 1000);
  if (ageSec < 60)   return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)} min ago`;
  return `${Math.floor(ageSec / 3600)}h ago`;
}

/** Format uptime seconds as Xh Ym. */
function _uptimeLabel(seconds) {
  if (seconds == null) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function buildSummary(model) {
  const ts    = model._updatedAt ?? 'never';
  const stale = model._staleDimensions ?? [];
  const lines = [`Appliance state as of ${ts}:`, ''];

  function dimLine(key, label, details) {
    const age = _ageLabel(model[key]?.checked_at);
    if (stale.includes(key)) {
      const threshMin = Math.floor(STALENESS_MS[key] / 60000);
      const lastKnown = model[key]?.overall_status
        ?? (model[key]?.skipped
            ? 'monitoring disabled'
            : model[key]?.has_violations != null
              ? (model[key].has_violations ? 'violations present' : 'OK')
              : 'unknown');
      return [
        `  ${label.padEnd(13)} STALE — last checked ${age} (threshold ${threshMin} min)`,
        `                 Last known: ${lastKnown}`,
        `                 → Run a fresh probe for current data.`,
      ].join('\n');
    }
    return `  ${label.padEnd(13)} ${details}  (checked ${age})`;
  }

  // health
  if (model.health) {
    const h   = model.health;
    const up  = h.process?.uptime_seconds != null ? `, uptime ${_uptimeLabel(h.process.uptime_seconds)}` : '';
    const det = h.error
      ? `${h.overall_status ?? 'unknown'} — ${h.error}`
      : `${h.overall_status ?? 'unknown'} — SSH ${h.ssh_connected ? 'up' : 'down'}, ` +
        `HTTP ${h.http_health?.status_code ?? '?'}/${h.http_ready?.status_code ?? '?'}, ` +
        `systemd ${h.process?.running ? 'active' : 'inactive'}${up}`;
    lines.push(dimLine('health', 'health:', det));
  } else {
    lines.push(`  health:        no data — run health_check to initialize`);
  }

  // resources
  if (model.resources) {
    const r   = model.resources;
    const det = r.skipped
      ? 'monitoring disabled'
      : r.has_violations
        ? `${r.findings_count} threshold violation(s) — ${r.summary}`
        : `OK — ${r.sampled_processes ?? '?'} processes within thresholds`;
    lines.push(dimLine('resources', 'resources:', det));
  } else {
    lines.push(`  resources:     no data`);
  }

  // application
  if (model.application) {
    const a     = model.application;
    const parts = [];
    if (a.active_orders != null)          parts.push(`${a.active_orders} active orders`);
    if (a.db_size_bytes != null)          parts.push(`DB ${Math.round(a.db_size_bytes / 1024 / 1024)} MB`);
    if (a.online_ordering_paused === true)  parts.push('online ordering PAUSED');
    else if (a.online_ordering_paused === false) parts.push('online ordering enabled');
    const det = a.error
      ? `error: ${a.error}`
      : parts.length > 0 ? parts.join(', ') : 'no data';
    lines.push(dimLine('application', 'application:', det));
  } else {
    lines.push(`  application:   no data`);
  }

  // network
  if (model.network) {
    const n   = model.network;
    const det = n.internet_up === false
      ? 'internet DOWN'
      : n.internet_ip
        ? `internet up, IP ${n.internet_ip}${n.lan_devices != null ? `, ${n.lan_devices} LAN devices` : ''}`
        : 'no data';
    lines.push(dimLine('network', 'network:', det));
  } else {
    lines.push(`  network:       no data`);
  }

  // security
  if (model.security) {
    const s     = model.security;
    const parts = [];
    if (s.last_compliance_pass != null) parts.push(s.last_compliance_pass ? 'compliance OK' : 'compliance FAIL');
    if (s.credential_audit_ok != null)  parts.push(s.credential_audit_ok  ? 'credential audit OK' : 'credential audit FAIL');
    if (s.git_audit_ok != null)         parts.push(s.git_audit_ok         ? 'git audit OK'         : 'git audit FAIL');
    const det = parts.length > 0 ? parts.join(', ') : 'no data';
    lines.push(dimLine('security', 'security:', det));
  } else {
    lines.push(`  security:      no data`);
  }

  lines.push('');
  lines.push(stale.length === 0
    ? 'Stale dimensions: (none)'
    : `Stale dimensions: ${stale.join(', ')}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function persistSnapshot(model) {
  const db  = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO appliance_state
      (appliance_name, health, resources, application, network, security, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    model.applianceName,
    model.health      ? JSON.stringify(model.health)      : null,
    model.resources   ? JSON.stringify(model.resources)   : null,
    model.application ? JSON.stringify(model.application) : null,
    model.network     ? JSON.stringify(model.network)     : null,
    model.security    ? JSON.stringify(model.security)    : null,
    now,
  );
}

function persistHistoryEntry(applianceName, dimension, data) {
  const db = getDb();
  db.prepare(`
    INSERT INTO appliance_state_history (appliance_name, dimension, data, recorded_at)
    VALUES (?, ?, ?, ?)
  `).run(applianceName, dimension, JSON.stringify(data), new Date().toISOString());
}

function loadSavedSnapshot(applianceName) {
  const db  = getDb();
  const row = db.prepare(
    `SELECT * FROM appliance_state WHERE appliance_name = ?`
  ).get(applianceName);
  if (!row) return null;
  return {
    health:      row.health      ? JSON.parse(row.health)      : null,
    resources:   row.resources   ? JSON.parse(row.resources)   : null,
    application: row.application ? JSON.parse(row.application) : null,
    network:     row.network     ? JSON.parse(row.network)     : null,
    security:    row.security    ? JSON.parse(row.security)    : null,
    updated_at:  row.updated_at,
  };
}

function _pruneHistory(applianceName) {
  const db = getDb();
  const result = db.prepare(`
    DELETE FROM appliance_state_history
    WHERE appliance_name = ? AND recorded_at < datetime('now', '-7 days')
  `).run(applianceName);
  if (result.changes > 0) {
    log.info(`[asm] pruned ${result.changes} history row(s) older than 7 days`);
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton state
// ---------------------------------------------------------------------------

let _samInst        = null;
let _samApi         = null;
let _intent         = null;
let _cachedSnapshot = null;
let _cachedSummary  = null;
let _applianceName  = null;

// ---------------------------------------------------------------------------
// SAM action
// ---------------------------------------------------------------------------

/**
 * Validate dimension and pass data through to the acceptor.
 *
 * @param {{ dimension: string, data: object }} params
 * @returns {{ dimension: string, data: object }}
 */
async function applyProbeAction({ dimension, data }) {
  if (!DIMENSIONS.includes(dimension)) {
    throw new Error(`[asm] Unknown dimension: "${dimension}"`);
  }
  return { dimension, data };
}

// ---------------------------------------------------------------------------
// SAM acceptors
// ---------------------------------------------------------------------------

/**
 * A1 — Merge the normalized probe result into the matching model dimension.
 */
const mergeDimensionAcceptor = model => proposal => {
  if (!proposal.dimension || !('data' in proposal)) return;
  const { dimension, data } = proposal;

  // Security uses the existing value for incremental merge.
  model[dimension]     = normalizeDimension(dimension, data, model[dimension]);
  model._updatedAt     = new Date().toISOString();
  model._lastDimension = dimension;
};

/**
 * A2 — Recompute the set of stale dimensions after every merge.
 */
const stalenessAcceptor = model => _proposal => {
  const now   = Date.now();
  const stale = [];
  for (const dim of DIMENSIONS) {
    const checkedAt = model[dim]?.checked_at;
    if (!checkedAt || now - new Date(checkedAt).getTime() > STALENESS_MS[dim]) {
      stale.push(dim);
    }
  }
  model._staleDimensions = stale;
};

// ---------------------------------------------------------------------------
// SAM render
// ---------------------------------------------------------------------------

function render(model) {
  // Guard: skip on initialization render before any probe has fired.
  if (!model._lastDimension) return;

  try {
    persistHistoryEntry(model.applianceName, model._lastDimension, model[model._lastDimension]);
    persistSnapshot(model);
  } catch (err) {
    log.error(`[asm] persist failed: ${err.message}`);
  }

  _cachedSnapshot = buildSnapshot(model);
  _cachedSummary  = buildSummary(model);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the ASM singleton. Must be called once from main.js after
 * runMigrations() and before cronScheduler.start().
 */
function init() {
  const { appliance } = getConfig();
  _applianceName = appliance.appliance?.name ?? 'unknown-appliance';

  runAsmMigrations();
  _pruneHistory(_applianceName);

  const saved = loadSavedSnapshot(_applianceName);

  _samInst = createInstance({ instanceName: 'appliance-state-machine' });
  _samApi  = api(_samInst);

  _samApi.addInitialState({
    applianceName:    _applianceName,
    health:           saved?.health      ?? null,
    resources:        saved?.resources   ?? null,
    application:      saved?.application ?? null,
    network:          saved?.network     ?? null,
    security:         saved?.security    ?? null,
    _updatedAt:       saved?.updated_at  ?? null,
    _staleDimensions: [],
    _lastDimension:   null,
  });

  _samApi.addAcceptors([mergeDimensionAcceptor, stalenessAcceptor]);
  // No NAPs — probe scheduling is external (cron-scheduler).

  const { intents: [probeIntent] } = _samApi.getIntents([applyProbeAction]);
  _intent = probeIntent;

  _samApi.setRender(model => render(model));

  // Warm the in-memory cache from saved state so Layer 8 is populated
  // immediately on restart without waiting for the first cron probe.
  if (saved) {
    const now   = Date.now();
    const stale = DIMENSIONS.filter(dim => {
      const checkedAt = saved[dim]?.checked_at;
      return !checkedAt || now - new Date(checkedAt).getTime() > STALENESS_MS[dim];
    });
    _cachedSnapshot = buildSnapshot({
      applianceName:    _applianceName,
      ...saved,
      _updatedAt:       saved.updated_at,
      _staleDimensions: stale,
    });
    _cachedSummary  = buildSummary({
      applianceName:    _applianceName,
      ...saved,
      _updatedAt:       saved.updated_at,
      _staleDimensions: stale,
    });
  }

  log.info(`[asm] initialized — appliance=${_applianceName}, warmed=${saved ? 'yes' : 'no'}`);
}

/**
 * Apply a probe result to the ASM model. Called from cron tasks after each
 * probe tool runs. Fire-and-forget — errors are logged, never thrown.
 *
 * @param {'health'|'resources'|'application'|'network'|'security'} dimension
 * @param {object} data  Raw output from the probe tool.
 */
function applyProbe(dimension, data) {
  if (!_intent) {
    log.warn('[asm] applyProbe called before init() — ignoring');
    return;
  }
  _intent({ dimension, data }).catch(err => {
    log.error(`[asm] applyProbe(${dimension}) error: ${err.message}`);
  });
}

/**
 * Return the full current snapshot (all five dimensions + metadata).
 * Synchronous — reads the in-memory cache; never probes the appliance.
 *
 * @returns {object|null}
 */
function getSnapshot() {
  return _cachedSnapshot;
}

/**
 * Return a compact multi-line summary string for system-prompt injection.
 * Synchronous — reads the in-memory cache; never probes the appliance.
 *
 * @returns {string|null}
 */
function getSummary() {
  return _cachedSummary;
}

/**
 * Return true if the given dimension was probed within its freshness threshold.
 *
 * @param {'health'|'resources'|'application'|'network'|'security'} dimension
 * @returns {boolean}
 */
function isFresh(dimension) {
  const snap = _cachedSnapshot;
  if (!snap || !snap[dimension]?.checked_at) return false;
  const ageMs = Date.now() - new Date(snap[dimension].checked_at).getTime();
  return ageMs <= STALENESS_MS[dimension];
}

/**
 * Return up to `limit` history entries for a dimension, newest first.
 * Queries SQLite — not in-memory.
 *
 * @param {'health'|'resources'|'application'|'network'|'security'} dimension
 * @param {number} [limit=12]
 * @returns {Array<{ data: object, recorded_at: string }>}
 */
function getHistory(dimension, limit = 12) {
  if (!_applianceName) return [];
  const db = getDb();
  return db.prepare(`
    SELECT data, recorded_at
    FROM appliance_state_history
    WHERE appliance_name = ? AND dimension = ?
    ORDER BY recorded_at DESC
    LIMIT ?
  `).all(_applianceName, dimension, limit).map(row => ({
    data:        JSON.parse(row.data),
    recorded_at: row.recorded_at,
  }));
}

/**
 * Delete history rows older than 7 days. Called from the nightly archive-check
 * cron task to keep appliance_state_history bounded.
 */
function pruneOldHistory() {
  if (!_applianceName) return;
  _pruneHistory(_applianceName);
}

/**
 * Tear down the singleton (for graceful shutdown and tests).
 */
function close() {
  _samInst        = null;
  _samApi         = null;
  _intent         = null;
  _cachedSnapshot = null;
  _cachedSummary  = null;
  _applianceName  = null;
}

module.exports = {
  init,
  applyProbe,
  getSnapshot,
  getSummary,
  isFresh,
  getHistory,
  pruneOldHistory,
  close,
  // Exported for unit testing:
  _buildSummary:     buildSummary,
  _buildSnapshot:    buildSnapshot,
  _normalizeDimension: normalizeDimension,
  STALENESS_MS,
  DIMENSIONS,
};
