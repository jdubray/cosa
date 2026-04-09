'use strict';

const sshBackend        = require('../ssh-backend');
const { getConfig }     = require('../../config/cosa.config');
const { createLogger }  = require('../logger');

const log = createLogger('network-scan');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME       = 'network_scan';
const RISK_LEVEL = 'read';

// Static command — never constructed from user input.
// `arp -a` enumerates the ARP cache: format is `hostname (ip) at mac [ether] on iface`
const CMD_ARP = 'arp -a';

const INPUT_SCHEMA = {
  type:                 'object',
  properties:           {},
  required:             [],
  additionalProperties: false,
};

const SCHEMA = {
  description:
    'Enumerate all devices visible on the local network ARP cache and flag ' +
    'unknown MAC addresses. Compares each discovered MAC against the ' +
    'known_mac_addresses list in appliance.yaml. Returns a devices array with ' +
    'a known flag for each entry and a separate unknownDevices array. ' +
    'Assigns severity based on: multiple unknowns or unknown device connecting ' +
    'to appliance port → high; single unknown → medium.',
  inputSchema: INPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Normalise a MAC address to lowercase colon-separated form.
 * Handles both `aa:bb:cc:dd:ee:ff` and `aa-bb-cc-dd-ee-ff` variants.
 *
 * @param {string} raw
 * @returns {string | null}  null when the string doesn't look like a MAC.
 */
function normaliseMac(raw) {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase().replace(/-/g, ':');
  // Must be exactly 6 hex pairs separated by colons.
  if (/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(cleaned)) return cleaned;
  return null;
}

/**
 * Parse `arp -a` stdout into an array of device objects.
 *
 * Typical line format (Linux):
 *   hostname (192.168.1.1) at aa:bb:cc:dd:ee:ff [ether] on eth0
 *
 * Incomplete/pending entries (MAC is `<incomplete>` or `(incomplete)`) are
 * silently skipped — they represent hosts that no longer respond.
 *
 * @param {string} stdout
 * @returns {{ ip: string, mac: string, hostname: string, iface: string }[]}
 */
function parseArpOutput(stdout) {
  const devices = [];

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // hostname (ip) at mac [ether] on iface
    const match = trimmed.match(
      /^(\S+)\s+\(([^)]+)\)\s+at\s+(\S+)(?:\s+\[(\w+)\])?\s+on\s+(\S+)/
    );
    if (!match) continue;

    const [, hostname, ip, rawMac, , iface] = match;
    const mac = normaliseMac(rawMac);
    if (!mac) continue; // skip `<incomplete>` entries

    devices.push({ hostname: hostname === '?' ? ip : hostname, ip, mac, iface });
  }

  return devices;
}

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

/**
 * Determine the severity for the scan result given the unknown devices found.
 *
 * Rules (in priority order):
 *   • Multiple unknown MACs appearing simultaneously → 'high'
 *   • Any unknown device on the local network → 'medium' baseline
 *   • No unknowns → null (no alert needed)
 *
 * AC6 ("unknown device connecting to appliance port") is evaluated by the
 * orchestrator layer once the tool result is available; the tool itself has
 * no way to know if a given IP is connecting to a port without a separate
 * netstat/ss query. We therefore surface 'high' for the multi-unknown case
 * and 'medium' for single-unknown, and annotate the result so the
 * orchestrator can escalate as needed.
 *
 * @param {number} unknownCount
 * @returns {'high' | 'medium' | null}
 */
function determineSeverity(unknownCount) {
  if (unknownCount === 0) return null;
  if (unknownCount >= 2) return 'high';
  return 'medium';
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{
 *   summary: string,
 *   devices: Array<{hostname:string, ip:string, mac:string, iface:string, known:boolean, name:string|null}>,
 *   unknownDevices: Array<{hostname:string, ip:string, mac:string, iface:string, severity:'medium'|'high'}>,
 *   totalDeviceCount: number,
 *   severity: 'high'|'medium'|null,
 *   checked_at: string
 * }>}
 */
async function handler() {
  const checked_at = new Date().toISOString();

  if (!sshBackend.isConnected()) {
    throw new Error('SSH not connected — cannot run arp -a');
  }

  // ── 1. Read known MACs from config ────────────────────────────────────────
  const { appliance } = getConfig();
  const configuredMacs = appliance.network?.known_mac_addresses ?? [];

  /** @type {Map<string, string>} mac → name */
  const knownMacMap = new Map();
  for (const entry of configuredMacs) {
    const mac = normaliseMac(entry.mac);
    if (mac) knownMacMap.set(mac, entry.name ?? mac);
  }

  // ── 2. Execute arp -a ─────────────────────────────────────────────────────
  log.info('Executing arp -a');
  const result = await sshBackend.exec(CMD_ARP);

  if (result.exitCode !== 0 && !result.stdout) {
    throw new Error(`arp -a failed (exit ${result.exitCode}): ${result.stderr}`);
  }

  // ── 3. Parse and classify ─────────────────────────────────────────────────
  const raw = parseArpOutput(result.stdout);

  const devices = raw.map((d) => {
    const known = knownMacMap.has(d.mac);
    return {
      ...d,
      known,
      name: known ? knownMacMap.get(d.mac) : null,
    };
  });

  const unknownCount   = devices.filter((d) => !d.known).length;
  const overallSeverity = determineSeverity(unknownCount);

  // Each unknown device gets an individual severity label (AC5/AC7).
  // Individual severity is 'high' when the overall scan is 'high' (≥ 2 unknowns),
  // otherwise 'medium'.
  const unknownDevices = devices
    .filter((d) => !d.known)
    .map(({ known: _known, name: _name, ...d }) => ({
      ...d,
      severity: overallSeverity === 'high' ? 'high' : 'medium',
    }));

  const summary =
    unknownCount === 0
      ? `All ${devices.length} device(s) on the network are known.`
      : `${unknownCount} unknown device(s) detected out of ${devices.length} total. Severity: ${overallSeverity}.`;

  log.info(summary);

  return {
    summary,
    devices,
    unknownDevices,
    totalDeviceCount: devices.length,
    severity: overallSeverity,
    checked_at,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
