'use strict';

const sshBackend   = require('../ssh-backend');
const { getConfig } = require('../../config/cosa.config');
const { createLogger } = require('../logger');

const log = createLogger('process-monitor');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME       = 'process_monitor';
const RISK_LEVEL = 'read';

// Static commands — never constructed from user input.
const CMD_PS       = 'ps aux --no-headers';
const CMD_SS       = 'ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null';

const INPUT_SCHEMA = {
  type:                 'object',
  properties:           {},
  required:             [],
  additionalProperties: false,
};

const SCHEMA = {
  description:
    'List all running processes on the Baanbaan appliance via SSH and flag ' +
    'unexpected PIDs against the expectedProcesses list in appliance.yaml. ' +
    'Returns a processes array (each with expected/suspicious flags), an ' +
    'unknownProcesses array, and a listeningPorts array. ' +
    'Severity: medium for unknown processes, high for unknown processes on ' +
    'listening ports, critical for unknown root binaries.',
  inputSchema: INPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse the output of `ps aux --no-headers` into structured records.
 *
 * ps aux columns (space-separated, command may contain spaces):
 *   USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
 *
 * @param {string} stdout
 * @returns {Array<{ user: string, pid: number, cpu: number, mem: number, command: string }>}
 */
function parsePsOutput(stdout) {
  const processes = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Split on whitespace, max 11 fields (last field is COMMAND which may have spaces)
    const parts = trimmed.split(/\s+/);
    if (parts.length < 11) continue;

    const [user, pidStr, cpuStr, memStr, , , , , , , ...cmdParts] = parts;
    const pid = parseInt(pidStr, 10);
    if (isNaN(pid)) continue;

    processes.push({
      user,
      pid,
      cpu:     parseFloat(cpuStr) || 0,
      mem:     parseFloat(memStr) || 0,
      command: cmdParts.join(' '),
    });
  }
  return processes;
}

/**
 * Parse `ss -tlnp` or `netstat -tlnp` output into a list of listening ports.
 *
 * We extract numeric ports from lines that contain LISTEN or tcp.
 * This is best-effort — exact format varies by tool version.
 *
 * @param {string} stdout
 * @returns {number[]} Sorted unique port numbers.
 */
function parseListeningPorts(stdout) {
  const ports = new Set();

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('State') || trimmed.startsWith('Proto')) continue;

    // Match patterns like :22 or *:3000 or 0.0.0.0:8080 or :::443
    const portMatches = trimmed.matchAll(/:(\d+)(?:\s|$)/g);
    for (const match of portMatches) {
      const port = parseInt(match[1], 10);
      if (!isNaN(port) && port > 0 && port < 65536) {
        ports.add(port);
      }
    }
  }

  return [...ports].sort((a, b) => a - b);
}

/**
 * Determine whether a process command matches any expected process pattern.
 * Matching is substring containment (case-sensitive) against the COMMAND column.
 *
 * @param {string} command
 * @param {string[]} expectedPatterns
 * @returns {boolean}
 */
function isExpected(command, expectedPatterns) {
  return expectedPatterns.some((pattern) => command.includes(pattern));
}

/**
 * Classify the severity of an unexpected process.
 *
 * Rules (highest wins):
 *   critical — unknown binary running as root
 *   high     — unknown process with a port in the listening set
 *   medium   — unknown process (no port, not root)
 *
 * @param {{ user: string, pid: number, command: string }} proc
 * @param {Set<number>} listeningPortSet - Ports actually open on the host.
 * @param {Set<number>} knownPortSet     - Ports allowed by config.
 * @returns {'critical'|'high'|'medium'}
 */
function classifySeverity(proc, listeningPortSet, knownPortSet) {
  if (proc.user === 'root') return 'critical';

  // Check if this process has an open port that is NOT in the known set.
  // We can't easily map a specific PID to a specific port from ps alone, so
  // if there are any unknown listening ports we promote unknown processes to
  // 'high'. This is conservative — the full correlation is in the port report.
  const hasUnknownPort = [...listeningPortSet].some((p) => !knownPortSet.has(p));
  if (hasUnknownPort) return 'high';

  return 'medium';
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<object>}
 */
async function handler() {
  const checkedAt = new Date().toISOString();
  const config    = getConfig();

  const expectedPatterns = (config.appliance?.monitoring?.expected_processes ?? []).map(String);
  const knownPortList    = (config.appliance?.monitoring?.known_ports         ?? []).map(Number);
  const knownPortSet     = new Set(knownPortList);

  if (expectedPatterns.length === 0) {
    log.warn(
      'monitoring.expected_processes is empty in appliance.yaml — ' +
      'all processes will be flagged as unknown.'
    );
  }

  // ── SSH connectivity check ────────────────────────────────────────────────
  if (!sshBackend.isConnected()) {
    throw new Error('SSH not connected — cannot run process monitor');
  }

  // ── Collect process list ──────────────────────────────────────────────────
  log.info('Running ps aux via SSH');
  const psResult = await sshBackend.exec(CMD_PS);
  if (psResult.exitCode !== 0) {
    throw new Error(`ps aux failed (exit ${psResult.exitCode}): ${psResult.stderr}`);
  }

  const rawProcesses = parsePsOutput(psResult.stdout);
  log.info(`Parsed ${rawProcesses.length} processes`);

  // ── Collect listening ports ───────────────────────────────────────────────
  log.info('Running ss/netstat via SSH');
  const ssResult = await sshBackend.exec(CMD_SS);
  // ss/netstat exit codes vary; we tolerate non-zero if stdout has data.
  const listeningPorts = parseListeningPorts(ssResult.stdout);
  const listeningPortSet = new Set(listeningPorts);

  // ── Classify each process ─────────────────────────────────────────────────
  const processes = rawProcesses.map((proc) => {
    const expected   = isExpected(proc.command, expectedPatterns);
    const suspicious = !expected;
    return { ...proc, expected, suspicious };
  });

  // ── Collect unknown processes and assign severity ─────────────────────────
  const unknownProcesses = processes
    .filter((p) => p.suspicious)
    .map((proc) => ({
      user:     proc.user,
      pid:      proc.pid,
      cpu:      proc.cpu,
      mem:      proc.mem,
      command:  proc.command,
      severity: classifySeverity(proc, listeningPortSet, knownPortSet),
    }));

  // ── Unknown listening ports (not in known_ports config) ───────────────────
  const unknownListeningPorts = listeningPorts.filter((p) => !knownPortSet.has(p));

  // Build enriched listeningPorts array.
  const listeningPortsReport = listeningPorts.map((port) => ({
    port,
    known: knownPortSet.has(port),
  }));

  const summary = unknownProcesses.length === 0 && unknownListeningPorts.length === 0
    ? 'All processes match expected list. No unknown listening ports.'
    : `Found ${unknownProcesses.length} unknown process(es) and ${unknownListeningPorts.length} unknown listening port(s).`;

  log.info(
    `Process monitor: ${rawProcesses.length} total, ` +
    `${unknownProcesses.length} unknown, ` +
    `${unknownListeningPorts.length} unknown ports`
  );

  return {
    summary,
    processes,
    unknown_processes:  unknownProcesses,
    listening_ports:    listeningPortsReport,
    unknown_ports:      unknownListeningPorts,
    total_process_count: rawProcesses.length,
    checked_at:         checkedAt,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
