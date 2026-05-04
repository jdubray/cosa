'use strict';

const sshBackend    = require('../ssh-backend');
const { getConfig } = require('../../config/cosa.config');
const { createLogger } = require('../logger');

const log = createLogger('resource-threshold-monitor');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME       = 'resource_threshold_monitor';
const RISK_LEVEL = 'read';

const INPUT_SCHEMA = {
  type:                 'object',
  properties:           {},
  required:             [],
  additionalProperties: false,
};

const SCHEMA = {
  description:
    'Sample CPU, RSS, and system memory on the appliance using top -bn5 -d 2 and ' +
    '/proc/meminfo, then evaluate each process against per-pattern thresholds from ' +
    'appliance.yaml. Returns findings for: spike, sustained_cpu, rss_over_sustained, ' +
    'age_over (short-lived CLI), aggregate_cpu, system_memory_low, and ' +
    'singleton_orphan (duplicate long-running service). Always read-only.',
  inputSchema: INPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse the batch output of `top -bn5 -d 2` into an array of per-iteration
 * samples.  Each element represents one top refresh cycle and contains the
 * aggregate CPU percentage and an array of per-process observations.
 *
 * top -b batch-mode column order (1-indexed, space-delimited):
 *   PID USER PR NI VIRT RES SHR S %CPU %MEM TIME+ COMMAND…
 *   [0]  [1]  [2][3] [4] [5] [6] [7] [8]  [9]  [10]  [11+]
 *
 * @param {string} stdout
 * @returns {Array<{
 *   aggregateCpu: number,
 *   processes: Array<{ pid: number, cpu: number, rssMb: number, command: string }>
 * }>}
 */
function parseTopBatch(stdout) {
  // Split into per-iteration blocks on the "top - HH:MM:SS …" header lines.
  // The first block already starts with "top - "; subsequent blocks lose the
  // "top - " prefix (it becomes the split delimiter), which is harmless because
  // we locate %Cpu(s) and process rows by content, not position.
  const blocks = stdout.split(/\ntop - /);
  const samples = [];

  for (const block of blocks) {
    if (!block.trim()) continue;

    // Extract aggregate CPU: us + sy + ni (ignore id/wa/hi/si/st).
    const cpuMatch = block.match(
      /%Cpu\(s\):\s*([\d.]+)\s*us,\s*([\d.]+)\s*sy,\s*([\d.]+)\s*ni/
    );
    if (!cpuMatch) continue;

    const aggregateCpu =
      parseFloat(cpuMatch[1]) + parseFloat(cpuMatch[2]) + parseFloat(cpuMatch[3]);

    // Extract process rows.  A valid row has a numeric PID as its first field
    // and at least 12 whitespace-delimited tokens (PID…COMMAND).
    const processes = [];
    for (const line of block.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const parts = trimmed.split(/\s+/);
      if (parts.length < 12) continue;

      const pid = parseInt(parts[0], 10);
      if (isNaN(pid) || pid <= 0) continue;

      const rssKib  = parseInt(parts[5], 10);
      const cpu     = parseFloat(parts[8]);
      const command = parts.slice(11).join(' ');

      if (isNaN(rssKib) || isNaN(cpu) || !command) continue;

      processes.push({
        pid,
        cpu,
        rssMb:   rssKib / 1024,
        command,
      });
    }

    samples.push({ aggregateCpu, processes });
  }

  return samples;
}

/**
 * Parse a single `/proc/meminfo` snapshot and extract `MemAvailable` in MiB.
 *
 * @param {string} stdout
 * @returns {{ memAvailableMib: number | null }}
 */
function parseMemInfo(stdout) {
  const match = stdout.match(/^MemAvailable:\s+(\d+)\s+kB/m);
  if (!match) return { memAvailableMib: null };
  return { memAvailableMib: parseInt(match[1], 10) / 1024 };
}

/**
 * Parse `ps -o pid,etimes,command --no-headers -p <pids>` output into a
 * Map of pid → age in seconds.
 *
 * @param {string} stdout
 * @returns {Map<number, number>}
 */
function parsePsEtimes(stdout) {
  const map = new Map();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;

    const pid    = parseInt(parts[0], 10);
    const etimes = parseInt(parts[1], 10);
    if (isNaN(pid) || isNaN(etimes)) continue;

    map.set(pid, etimes);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Roll-up helper
// ---------------------------------------------------------------------------

/**
 * Aggregate per-sample process observations into a per-PID structure that
 * holds the full time-series of CPU and RSS values across all iterations.
 *
 * @param {Array<{ processes: Array }>} samples
 * @returns {Map<number, {
 *   command: string,
 *   cpuSamples: number[],
 *   rssSamplesMb: number[],
 *   latestRssMb: number
 * }>}
 */
function rollupByPid(samples) {
  const map = new Map();
  for (const sample of samples) {
    for (const proc of sample.processes) {
      if (!map.has(proc.pid)) {
        map.set(proc.pid, {
          command:      proc.command,
          cpuSamples:   [],
          rssSamplesMb: [],
          latestRssMb:  proc.rssMb,
        });
      }
      const entry = map.get(proc.pid);
      entry.cpuSamples.push(proc.cpu);
      entry.rssSamplesMb.push(proc.rssMb);
      entry.latestRssMb = proc.rssMb;   // update to most recent sample
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Profile matching
// ---------------------------------------------------------------------------

/**
 * Resolve the effective threshold profile for a process COMMAND string.
 *
 * Matching is substring containment, case-sensitive (same convention as
 * `expected_processes`).  All matching patterns are applied in order; the
 * last matching entry wins on any conflicting key (most-specific-last).
 *
 * @param {string} command
 * @param {object} cfg   - resource_threshold_monitor config block
 * @returns {object}     - merged profile (defaults + any overrides)
 */
function matchProfile(command, cfg) {
  let profile = { ...cfg.defaults };
  for (const pat of cfg.patterns ?? []) {
    if (command.includes(pat.match)) {
      profile = { ...profile, ...pat };
    }
  }
  return profile;
}

// ---------------------------------------------------------------------------
// Evaluation helpers
// ---------------------------------------------------------------------------

/**
 * Count sample values strictly greater than `threshold`.
 * Null/undefined values are skipped.
 *
 * @param {Array<number|null|undefined>} samples
 * @param {number} threshold
 * @returns {number}
 */
function countOver(samples, threshold) {
  return samples.filter(s => s != null && s > threshold).length;
}

/**
 * Count sample values strictly less than `threshold` (floor-alert twin).
 * Null/undefined values are skipped.
 *
 * @param {Array<number|null|undefined>} samples
 * @param {number} threshold
 * @returns {number}
 */
function countUnder(samples, threshold) {
  return samples.filter(s => s != null && s < threshold).length;
}

// ---------------------------------------------------------------------------
// Singleton orphan grouping
// ---------------------------------------------------------------------------

/**
 * Group PIDs that match a `singleton: true` pattern.
 *
 * For each PID, the last pattern with `singleton: true` that matches its
 * command becomes the group key (mirrors matchProfile last-match-wins logic).
 * Only patterns explicitly flagged `singleton: true` are considered.
 *
 * @param {Map}    perPid   - output of rollupByPid
 * @param {object} cfg
 * @param {Map}    ageByPid - pid → etimes seconds
 * @returns {Map<string, Array<{ pid, ageSec, command, latestRssMb }>>}
 */
function groupPidsByMatchedPattern(perPid, cfg, ageByPid) {
  const groups = new Map();
  for (const [pid, p] of perPid) {
    let lastMatch = null;
    for (const pat of cfg.patterns ?? []) {
      if (pat.singleton && p.command.includes(pat.match)) {
        lastMatch = pat.match;
      }
    }
    if (!lastMatch) continue;

    if (!groups.has(lastMatch)) groups.set(lastMatch, []);
    groups.get(lastMatch).push({
      pid,
      ageSec:      ageByPid.get(pid) ?? 0,
      command:     p.command,
      latestRssMb: p.latestRssMb,
    });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{
 *   summary: string,
 *   findings: object[],
 *   sampled_processes: number,
 *   samples_taken: number,
 *   checked_at: string,
 * } | { skipped: true }>}
 */
async function handler() {
  const cfg = getConfig().appliance.tools?.resource_threshold_monitor ?? {};
  if (cfg.enabled === false) return { skipped: true };

  // ── 1. Collect 5 CPU+process samples via top ──────────────────────────────
  const topResult = await sshBackend.exec('top -bn5 -d 2');
  if (topResult.exitCode !== 0) {
    throw new Error(`top failed (exit ${topResult.exitCode}): ${topResult.stderr}`);
  }
  const samples = parseTopBatch(topResult.stdout);

  // ── 2. Roll up per-PID across all samples ─────────────────────────────────
  const perPid = rollupByPid(samples);

  // ── 3. Process ages for every PID that appeared in any sample ────────────
  const pids = [...perPid.keys()];
  let ageByPid = new Map();
  if (pids.length > 0) {
    const ageResult = await sshBackend.exec(
      `ps -o pid,etimes,command --no-headers -p ${pids.join(',')}`
    );
    ageByPid = parsePsEtimes(ageResult.stdout);
  }

  // ── 4. System memory snapshot — one cat /proc/meminfo, replicated to match
  //       samples.length so the K-of-N API is uniform.  Degrade gracefully if
  //       the read fails; per-process and aggregate-CPU checks are unaffected.
  let memSamples;
  try {
    const memResult = await sshBackend.exec('cat /proc/meminfo');
    if (memResult.exitCode === 0) {
      const { memAvailableMib } = parseMemInfo(memResult.stdout);
      memSamples = samples.map(() => memAvailableMib);
    } else {
      log.warn('[rtm] /proc/meminfo returned non-zero exit — skipping system memory check');
      memSamples = samples.map(() => null);
    }
  } catch (err) {
    log.warn(`[rtm] /proc/meminfo read failed: ${err.message} — skipping system memory check`);
    memSamples = samples.map(() => null);
  }

  // ── 5. Per-process evaluation ─────────────────────────────────────────────
  const findings = [];
  const defaultsRequired = cfg.defaults?.samples_required ?? 4;

  for (const [pid, p] of perPid) {
    const profile        = matchProfile(p.command, cfg);
    const ageSec         = ageByPid.get(pid);
    const samplesRequired = profile.samples_required ?? defaultsRequired;

    // Spike — single sample over hard ceiling
    if (countOver(p.cpuSamples, profile.cpu_pct_spike) >= 1) {
      findings.push({
        kind:      'spike',
        pid,
        command:   p.command,
        cpu:       Math.max(...p.cpuSamples),
        threshold: profile.cpu_pct_spike,
        severity:  profile.severity ?? 'medium',
      });
    }

    // Sustained CPU — K-of-N samples over soft ceiling
    if (countOver(p.cpuSamples, profile.cpu_pct_sustained) >= samplesRequired) {
      findings.push({
        kind:      'sustained_cpu',
        pid,
        command:   p.command,
        samples:   p.cpuSamples,
        threshold: profile.cpu_pct_sustained,
        severity:  profile.severity ?? 'high',
      });
    }

    // Sustained RSS — K-of-N samples over RSS ceiling (replaces instantaneous check)
    const rssRequired = profile.rss_samples_required ?? samplesRequired;
    if (countOver(p.rssSamplesMb, profile.rss_mb) >= rssRequired) {
      findings.push({
        kind:           'rss_over_sustained',
        pid,
        command:        p.command,
        rss_samples_mb: p.rssSamplesMb,
        threshold:      profile.rss_mb,
        severity:       profile.severity ?? 'medium',
      });
    }

    // Age over — short-lived CLI that never exited
    if (profile.max_age_seconds != null && ageSec != null && ageSec > profile.max_age_seconds) {
      findings.push({
        kind:        'age_over',
        pid,
        command:     p.command,
        age_seconds: ageSec,
        threshold:   profile.max_age_seconds,
        severity:    profile.severity ?? 'high',
      });
    }
  }

  // ── 6. Aggregate CPU — total appliance CPU saturation ────────────────────
  const aggSamples = samples.map(s => s.aggregateCpu);
  if (cfg.aggregate_cpu &&
      countOver(aggSamples, cfg.aggregate_cpu.pct) >= cfg.aggregate_cpu.samples_required) {
    findings.push({
      kind:      'aggregate_cpu',
      samples:   aggSamples,
      threshold: cfg.aggregate_cpu.pct,
      severity:  cfg.aggregate_cpu.severity ?? 'high',
    });
  }

  // ── 7. System memory floor ────────────────────────────────────────────────
  if (cfg.system_memory &&
      countUnder(memSamples, cfg.system_memory.mib_floor) >= cfg.system_memory.samples_required) {
    findings.push({
      kind:        'system_memory_low',
      samples_mib: memSamples,
      floor_mib:   cfg.system_memory.mib_floor,
      severity:    cfg.system_memory.severity ?? 'high',
    });
  }

  // ── 8. Singleton orphan detection ─────────────────────────────────────────
  // A pattern with singleton: true expects exactly one matching PID.  If two
  // or more are present, the youngest (smallest etimes) is the active service;
  // older duplicates are orphans — probably left behind by a failed restart.
  const byPattern = groupPidsByMatchedPattern(perPid, cfg, ageByPid);
  for (const [matchKey, group] of byPattern) {
    if (group.length < 2) continue;
    // Sort ascending by age so [0] is newest (active), rest are orphans.
    const sorted = group.slice().sort((a, b) => a.ageSec - b.ageSec);
    const [active, ...orphans] = sorted;
    const pat = (cfg.patterns ?? []).find(p => p.match === matchKey);
    for (const o of orphans) {
      findings.push({
        kind:               'singleton_orphan',
        pid:                o.pid,
        command:            o.command,
        pattern:            matchKey,
        age_seconds:        o.ageSec,
        active_pid:         active.pid,
        active_age_seconds: active.ageSec,
        rss_mb:             o.latestRssMb,
        severity:           pat?.severity ?? 'high',
      });
    }
  }

  return {
    summary: findings.length === 0
      ? 'All processes within resource thresholds.'
      : `${findings.length} threshold violation(s); see findings.`,
    findings,
    sampled_processes: perPid.size,
    samples_taken:     samples.length,
    checked_at:        new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  name:      NAME,
  schema:    SCHEMA,
  handler,
  riskLevel: RISK_LEVEL,
  // Exported for unit testing:
  parseTopBatch,
  parseMemInfo,
  parsePsEtimes,
  matchProfile,
  rollupByPid,
  groupPidsByMatchedPattern,
  countOver,
  countUnder,
};
