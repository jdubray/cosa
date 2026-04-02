'use strict';

/**
 * SecurityFSM — Intrusion Escalation State Machine
 *
 * Manages the security incident lifecycle through 6 states using the same
 * fallback FSM pattern as session-fsm.js so it works without the optional
 * @cognitive-fab/sam-fsm package.
 *
 * States:
 *   monitoring          → Normal operation; watching for anomalies
 *   classifying         → Anomaly detected; determining severity
 *   alerting_operator   → Low/medium threat; operator notified; awaiting ack
 *   responding          → High/critical threat; automated response executing
 *   awaiting_clearance  → Response complete; waiting for operator to clear
 *   recovering          → Clearance received; restoring normal operations
 *
 * NAPs:
 *   - responding:       execute cloudflare_kill then ips_alert (if not yet done)
 *   - alerting_operator: send alert if not yet sent; schedule 15-min ALERT_TIMEOUT
 *
 * Persistence:
 *   All incidents are written to the security_incidents table in session.db.
 */

const crypto      = require('crypto');
const Database    = require('better-sqlite3');
const path        = require('path');
const fs          = require('fs');
const { getConfig }    = require('../config/cosa.config');
const toolRegistry     = require('./tool-registry');
const { createLogger } = require('./logger');

const log = createLogger('security-fsm');

// ---------------------------------------------------------------------------
// FSM transition table
// ---------------------------------------------------------------------------

/**
 * All valid transitions.  Key: "FROM:EVENT", Value: next state.
 * Invalid transitions throw — no silent failures (AC12).
 */
const TRANSITIONS = {
  // ── From monitoring ────────────────────────────────────────────────────────
  'monitoring:ANOMALY_DETECTED':   'classifying',

  // ── From classifying ──────────────────────────────────────────────────────
  'classifying:FALSE_POSITIVE':    'monitoring',
  'classifying:CLASSIFY_LOW':      'alerting_operator',
  'classifying:CLASSIFY_MEDIUM':   'alerting_operator',
  'classifying:CLASSIFY_HIGH':     'responding',
  'classifying:CLASSIFY_CRITICAL': 'responding',

  // ── From alerting_operator ─────────────────────────────────────────────────
  'alerting_operator:OPERATOR_ACK':    'awaiting_clearance',
  'alerting_operator:ALERT_TIMEOUT':   'responding',

  // ── From responding ────────────────────────────────────────────────────────
  'responding:RESPONSE_COMPLETE':  'awaiting_clearance',

  // ── From awaiting_clearance ────────────────────────────────────────────────
  'awaiting_clearance:CLEAR_THREAT': 'recovering',

  // ── From recovering ────────────────────────────────────────────────────────
  'recovering:HEALTH_CHECK_PASS':  'monitoring',
};

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/** @type {import('better-sqlite3').Database | null} */
let _db = null;

/**
 * Lazily open (or reuse) the session.db connection and ensure the
 * security_incidents table exists.
 *
 * @returns {import('better-sqlite3').Database}
 */
function getDb() {
  if (_db !== null) return _db;

  const { env } = getConfig();
  const dbDir   = path.resolve(process.cwd(), env.dataDir);
  fs.mkdirSync(dbDir, { recursive: true });

  const dbPath = path.join(dbDir, 'session.db');
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS security_incidents (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id     TEXT    NOT NULL UNIQUE,
      state           TEXT    NOT NULL,
      severity        TEXT,
      anomaly_type    TEXT,
      details         TEXT,
      cloudflare_killed INTEGER NOT NULL DEFAULT 0,
      alert_sent       INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT    NOT NULL,
      updated_at      TEXT    NOT NULL
    )
  `);

  _db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sec_incidents_state ON security_incidents(state)
  `);

  return _db;
}

/**
 * Persist a new incident row or update an existing one.
 *
 * @param {object} incident
 */
function upsertIncident(incident) {
  try {
    const db  = getDb();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO security_incidents
        (incident_id, state, severity, anomaly_type, details,
         cloudflare_killed, alert_sent, created_at, updated_at)
      VALUES
        (@incident_id, @state, @severity, @anomaly_type, @details,
         @cloudflare_killed, @alert_sent, @created_at, @updated_at)
      ON CONFLICT(incident_id) DO UPDATE SET
        state             = excluded.state,
        severity          = excluded.severity,
        cloudflare_killed = excluded.cloudflare_killed,
        alert_sent        = excluded.alert_sent,
        updated_at        = excluded.updated_at
    `).run({
      incident_id:       incident.incidentId,
      state:             incident.state,
      severity:          incident.severity   ?? null,
      anomaly_type:      incident.anomalyType ?? null,
      details:           incident.details    ? JSON.stringify(incident.details) : null,
      cloudflare_killed: incident.cloudflareKilled ? 1 : 0,
      alert_sent:        incident.alertSent        ? 1 : 0,
      created_at:        incident.createdAt ?? now,
      updated_at:        now,
    });
  } catch (err) {
    log.warn(`security_incidents upsert failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Core FSM builder
// ---------------------------------------------------------------------------

/**
 * Create a fresh SecurityFSM instance.
 *
 * Each incident should get its own instance so parallel incidents (rare but
 * possible) don't share state.
 *
 * @param {object} [opts]
 * @param {string} [opts.incidentId]   UUID for the incident (auto-generated if absent)
 * @returns {object} FSM instance
 */
function createSecurityFSM({ incidentId } = {}) {
  const incident = {
    incidentId:      incidentId ?? crypto.randomUUID(),
    state:           'monitoring',
    severity:        null,
    anomalyType:     null,
    details:         null,
    cloudflareKilled: false,
    alertSent:       false,
    alertTimeoutHandle: null,
    createdAt:       new Date().toISOString(),
  };

  // Persist initial state.
  upsertIncident(incident);

  // ── NAP helpers ─────────────────────────────────────────────────────────────

  /**
   * NAP for `responding` state:
   *   1. Execute cloudflare_kill if not yet killed.
   *   2. Send ips_alert after kill completes.
   *   3. Transition to RESPONSE_COMPLETE when done.
   */
  async function runRespondingNap() {
    if (!incident.cloudflareKilled) {
      try {
        log.info(`[${incident.incidentId}] Executing cloudflare_kill`);
        await toolRegistry.dispatch('cloudflare_kill', {});
        incident.cloudflareKilled = true;
        upsertIncident(incident);
        log.info(`[${incident.incidentId}] cloudflare_kill completed`);
      } catch (err) {
        log.warn(`[${incident.incidentId}] cloudflare_kill failed: ${err.message}`);
        // Continue — kill failure must not block the alert.
      }
    }

    // Always attempt ips_alert after the kill step (success or failure).
    try {
      log.info(`[${incident.incidentId}] Sending ips_alert`);
      await toolRegistry.dispatch('ips_alert', {
        alert_type: 'intrusion_detected',
        severity:   incident.severity ?? 'high',
        message:    `Security incident ${incident.incidentId}: automated response executed`,
        details:    incident.details,
      });
      incident.alertSent = true;
      upsertIncident(incident);
    } catch (err) {
      // ips_alert may not yet be registered; tolerate gracefully.
      if (err.code !== 'TOOL_NOT_FOUND') {
        log.warn(`[${incident.incidentId}] ips_alert failed: ${err.message}`);
      }
    }

    // Advance the FSM once automated response actions are complete.
    try {
      fsm.send('RESPONSE_COMPLETE');
    } catch (err) {
      log.warn(`[${incident.incidentId}] RESPONSE_COMPLETE transition failed: ${err.message}`);
    }
  }

  /**
   * NAP for `alerting_operator` state:
   *   1. Send ips_alert if not yet sent.
   *   2. Start 15-minute ALERT_TIMEOUT timer.
   */
  function runAlertingOperatorNap() {
    if (!incident.alertSent) {
      toolRegistry.dispatch('ips_alert', {
        alert_type: 'operator_alert',
        severity:   incident.severity ?? 'medium',
        message:    `Security incident ${incident.incidentId}: operator notification required`,
        details:    incident.details,
      }).then(() => {
        incident.alertSent = true;
        upsertIncident(incident);
        log.info(`[${incident.incidentId}] ips_alert sent to operator`);
      }).catch((err) => {
        if (err.code !== 'TOOL_NOT_FOUND') {
          log.warn(`[${incident.incidentId}] operator ips_alert failed: ${err.message}`);
        }
      });
    }

    // Schedule ALERT_TIMEOUT in 15 minutes if no ack arrives.
    if (incident.alertTimeoutHandle === null) {
      incident.alertTimeoutHandle = setTimeout(() => {
        incident.alertTimeoutHandle = null;
        if (incident.state === 'alerting_operator') {
          log.warn(`[${incident.incidentId}] Alert timeout — escalating to responding`);
          try {
            fsm.send('ALERT_TIMEOUT');
          } catch (err) {
            log.warn(`[${incident.incidentId}] ALERT_TIMEOUT transition failed: ${err.message}`);
          }
        }
      }, 15 * 60 * 1000);
      // Allow the process to exit cleanly if this timer is the only active handle.
      // The timer will still fire normally while the process is otherwise running.
      if (typeof incident.alertTimeoutHandle.unref === 'function') {
        incident.alertTimeoutHandle.unref();
      }
    }
  }

  // ── FSM object ──────────────────────────────────────────────────────────────

  const fsm = {
    /** @returns {string} current state */
    get current() { return incident.state; },

    /** @returns {string} incident UUID */
    get incidentId() { return incident.incidentId; },

    /**
     * Return true if EVENT is a valid transition from fromState.
     *
     * @param {string} fromState
     * @param {string} event
     * @returns {boolean}
     */
    can(fromState, event) {
      return Boolean(TRANSITIONS[`${fromState}:${event}`]);
    },

    /**
     * Validate and return the target state for a transition WITHOUT mutating.
     *
     * @param {string} fromState
     * @param {string} event
     * @returns {string} next state
     * @throws {Error} if the transition is invalid
     */
    transition(fromState, event) {
      const key  = `${fromState}:${event}`;
      const next = TRANSITIONS[key];
      if (!next) {
        throw new Error(
          `[SecurityFSM] Invalid transition: ${fromState} --[${event}]--> ? (no rule found)`
        );
      }
      return next;
    },

    /**
     * Send an event: validate the transition, mutate state, persist, run NAPs.
     *
     * @param {string} event
     * @param {object} [payload]   Optional context (severity, anomalyType, details)
     * @returns {string} new state
     * @throws {Error} if the transition is invalid (AC12)
     */
    send(event, payload = {}) {
      const next = this.transition(incident.state, event); // throws on invalid

      // Cancel any pending timeout before leaving alerting_operator.
      if (incident.state === 'alerting_operator' && incident.alertTimeoutHandle !== null) {
        clearTimeout(incident.alertTimeoutHandle);
        incident.alertTimeoutHandle = null;
      }

      // Merge payload into incident record.
      if (payload.severity)    incident.severity    = payload.severity;
      if (payload.anomalyType) incident.anomalyType = payload.anomalyType;
      if (payload.details)     incident.details     = payload.details;

      incident.state = next;
      upsertIncident(incident);

      log.info(`[${incident.incidentId}] ${event}: → ${next}`);

      // ── NAPs ────────────────────────────────────────────────────────────────
      if (next === 'responding') {
        // Fire-and-forget — the NAP manages its own error handling.
        runRespondingNap().catch((err) => {
          log.warn(`[${incident.incidentId}] respondingNap error: ${err.message}`);
        });
      }

      if (next === 'alerting_operator') {
        runAlertingOperatorNap();
      }

      // Auto-remove from the registry when the incident completes the full
      // recovery cycle (recovering → HEALTH_CHECK_PASS → monitoring).
      // This is the only valid path back to monitoring via send(), so the
      // delete is safe and prevents _instances from accumulating dead entries.
      if (next === 'monitoring') {
        _instances.delete(incident.incidentId);
      }

      return next;
    },

    /**
     * Reset the machine back to monitoring (for testing / post-recovery).
     * Does NOT trigger NAPs.
     */
    reset() {
      if (incident.alertTimeoutHandle !== null) {
        clearTimeout(incident.alertTimeoutHandle);
        incident.alertTimeoutHandle = null;
      }
      incident.state           = 'monitoring';
      incident.cloudflareKilled = false;
      incident.alertSent       = false;
      upsertIncident(incident);
    },

    /**
     * Expose internal incident data for tests.
     * @returns {object}
     */
    _getIncident() {
      return { ...incident };
    },
  };

  return fsm;
}

// ---------------------------------------------------------------------------
// Module-level singleton registry (keyed by incidentId)
// ---------------------------------------------------------------------------

const _instances = new Map();

/**
 * Get-or-create a SecurityFSM for the given incidentId.
 *
 * @param {string} [incidentId]
 * @returns {object} SecurityFSM instance
 */
function getInstance(incidentId) {
  if (incidentId && _instances.has(incidentId)) {
    return _instances.get(incidentId);
  }
  const fsm = createSecurityFSM({ incidentId });
  _instances.set(fsm.incidentId, fsm);
  return fsm;
}

/**
 * Remove an instance from the registry.
 *
 * The common case (HEALTH_CHECK_PASS completing the recovery cycle) is handled
 * automatically by `send()`.  This export is retained for callers that need to
 * evict an instance early (e.g. test teardown or forced cancellation).
 *
 * @param {string} incidentId
 */
function removeInstance(incidentId) {
  _instances.delete(incidentId);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  createSecurityFSM,
  getInstance,
  removeInstance,
  // Exported for testing
  TRANSITIONS,
};
