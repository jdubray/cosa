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
 * Parse `ss -tlnp` output into rich port detail records that include the bind
 * address and owning process name.  Used to suppress localhost-only ephemeral
 * ports (e.g. Puppeteer Chrome DevTools Protocol) that are not reachable
 * from outside the host.
 *
 * @param {string} stdout
 * @returns {Array<{ port: number, localAddr: string, processName: string|null }>}
 */
function parsePortDetails(stdout) {
  const details = [];

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('State') || trimmed.startsWith('Proto')) continue;

    // Match "localAddr:port" — handles "127.0.0.1:45951", "0.0.0.0:22", "*:3000"
    const addrPortMatch = trimmed.match(/(\S+):(\d+)\s+\S+/);
    if (!addrPortMatch) continue;

    const localAddr = addrPortMatch[1];
    const port      = parseInt(addrPortMatch[2], 10);
    if (isNaN(port) || port <= 0 || port >= 65536) continue;

    // Extract owning process name from users:(("procname",...))
    const procMatch   = trimmed.match(/users:\(\("([^"]+)"/);
    const processName = procMatch ? procMatch[1] : null;

    details.push({ port, localAddr, processName });
  }

  return details;
}

/**
 * Return true if the bind address is loopback-only (not reachable externally).
 *
 * @param {string} addr
 * @returns {boolean}
 */
function isLocalhostOnly(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '[::1]';
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
 *   high     — unknown process when any truly-unknown port is open
 *   medium   — unknown process (no unknown port, not root)
 *
 * "Truly unknown" means: not in known_ports AND not a localhost-only port
 * owned by an expected process (e.g. Puppeteer CDP).
 *
 * @param {{ user: string, pid: number, command: string }} proc
 * @param {Set<number>} unknownPortSet - Ports that are genuinely unaccounted for.
 * @returns {'critical'|'high'|'medium'}
 */
function classifySeverity(proc, unknownPortSet) {
  if (proc.user === 'root') return 'critical';

  // We can't map a specific PID to a specific port from ps alone, so we
  // promote all unknown processes to 'high' when any genuinely unknown port is
  // open. localhost-only ports owned by expected processes are already excluded
  // from unknownPortSet by the caller.
  if (unknownPortSet.size > 0) return 'high';

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

  // ── Filter out localhost-only ports owned by expected processes ───────────
  // Puppeteer/Chrome DevTools Protocol uses --remote-debugging-port=0 which
  // assigns an ephemeral loopback port each run.  These ports are not reachable
  // from outside the host and should not be treated as unknown.
  const portDetails = parsePortDetails(ssResult.stdout);
  const localhostKnownPorts = new Set(
    portDetails
      .filter((d) => isLocalhostOnly(d.localAddr) && d.processName && isExpected(d.processName, expectedPatterns))
      .map((d) => d.port)
  );

  // ── Classify each process ─────────────────────────────────────────────────
  const processes = rawProcesses.map((proc) => {
    const expected   = isExpected(proc.command, expectedPatterns);
    const suspicious = !expected;
    return { ...proc, expected, suspicious };
  });

  // ── Unknown listening ports (not in known_ports config, not localhost-only expected) ──
  const unknownListeningPorts = listeningPorts.filter(
    (p) => !knownPortSet.has(p) && !localhostKnownPorts.has(p)
  );
  const unknownPortSet = new Set(unknownListeningPorts);

  // ── Collect unknown processes and assign severity ─────────────────────────
  const unknownProcesses = processes
    .filter((p) => p.suspicious)
    .map((proc) => ({
      user:     proc.user,
      pid:      proc.pid,
      cpu:      proc.cpu,
      mem:      proc.mem,
      command:  proc.command,
      severity: classifySeverity(proc, unknownPortSet),
    }));

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
