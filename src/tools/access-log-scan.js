'use strict';

const sshBackend       = require('../ssh-backend');
const { getConfig }    = require('../../config/cosa.config');
const { createLogger } = require('../logger');

const log = createLogger('access-log-scan');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME       = 'access_log_scan';
const RISK_LEVEL = 'read';

/** Default log path on the remote appliance. */
const DEFAULT_LOG_PATH = '/var/log/nginx/access.log';

/** Default lookback window in minutes. */
const DEFAULT_LOOKBACK_MINUTES = 380;

/**
 * Known malicious scanner User-Agent substrings (lowercase for comparison).
 * Static list — never constructed from user input.
 */
const SCANNER_UA_PATTERNS = ['sqlmap', 'nikto'];

/**
 * SQL injection detection patterns applied to the raw query-string field.
 * These are JavaScript RegExp source strings matched case-insensitively.
 * Static list — never constructed from user input.
 */
const SQLI_PATTERNS = [
  /union\s+select/i,
  /'\s*or\s+'?1'?\s*=\s*'?1/i,
  /--\s*$/,
  /;\s*drop\s+table/i,
  /xp_cmdshell/i,
  /information_schema/i,
  /sleep\s*\(/i,
  /benchmark\s*\(/i,
  /\/\*.*\*\//,
];

const INPUT_SCHEMA = {
  type:                 'object',
  properties:           {},
  required:             [],
  additionalProperties: false,
};

const SCHEMA = {
  description:
    'Scan Baanbaan HTTP access logs for brute-force attempts, SQL injection probes, ' +
    'path scanning, and known malicious user agents. Reads the configured log file over ' +
    'SSH and analyses the last lookbackMinutes of entries. Returns an anomalies array ' +
    '(type, sourceIp, endpoint, count, windowMinutes, sample, severity), plus ' +
    'errorRatePercent and totalRequests.',
  inputSchema: INPUT_SCHEMA,
};

// ---------------------------------------------------------------------------
// Log-line parsing
// ---------------------------------------------------------------------------

/**
 * Parse a single combined-log-format line.
 *
 * Combined Log Format:
 *   IP - user [DD/Mon/YYYY:HH:MM:SS +ZZZZ] "METHOD /path?qs HTTP/x.y" status bytes "ref" "ua"
 *
 * @param {string} line
 * @returns {{ ip: string, ts: Date, method: string, path: string, qs: string,
 *             status: number, ua: string } | null}
 */
function parseLine(line) {
  // Minimal regex that tolerates missing referrer / UA fields.
  const m = line.match(
    /^(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"(\S+)\s+(\S+)\s+\S+"\s+(\d{3})\s+\S+(?:\s+"[^"]*")?\s*(?:"([^"]*)")?/
  );
  if (!m) return null;

  const [, ip, timeStr, method, rawPath, statusStr, ua = ''] = m;

  // Parse timestamp: "29/Mar/2026:14:05:32 +0000"
  // Convert to RFC 2822 space-delimited format that V8 reliably parses:
  // "29 Mar 2026 14:05:32 +0000"
  const ts = new Date(
    timeStr.replace(
      /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}:\d{2}:\d{2})\s([+-]\d{4})$/,
      '$1 $2 $3 $4 $5'
    )
  );
  if (Number.isNaN(ts.getTime())) return null;

  // Split path from query string.
  const qIdx = rawPath.indexOf('?');
  const path  = qIdx === -1 ? rawPath : rawPath.slice(0, qIdx);
  const qs    = qIdx === -1 ? '' : rawPath.slice(qIdx + 1);

  return { ip, ts, method, path, qs, status: Number(statusStr), ua };
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/**
 * Group entries by a string key and return groups with count >= minCount.
 *
 * @template T
 * @param {T[]} entries
 * @param {(e: T) => string} keyFn
 * @param {number} minCount
 * @returns {Map<string, T[]>}
 */
function groupBy(entries, keyFn, minCount) {
  /** @type {Map<string, T[]>} */
  const map = new Map();
  for (const e of entries) {
    const k = keyFn(e);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(e);
  }
  for (const [k, v] of map) {
    if (v.length < minCount) map.delete(k);
  }
  return map;
}

/**
 * Detect SSH brute-force: >5 failed logins (status 401) in any 5-minute window
 * from the same source IP.
 *
 * @param {{ ip: string, ts: Date, status: number, path: string }[]} entries
 * @returns {Array<{ type:string, sourceIp:string, endpoint:string, count:number,
 *                   windowMinutes:number, sample:string, severity:string }>}
 */
function detectBruteForce(entries) {
  const WINDOW_MS  = 5 * 60 * 1000;
  const THRESHOLD  = 5;
  const anomalies  = [];

  // Filter failed auth attempts (HTTP 401).
  const failed = entries.filter((e) => e.status === 401);

  // Group by IP.
  const byIp = new Map();
  for (const e of failed) {
    if (!byIp.has(e.ip)) byIp.set(e.ip, []);
    byIp.get(e.ip).push(e);
  }

  for (const [ip, hits] of byIp) {
    // Sort by timestamp ascending.
    hits.sort((a, b) => a.ts - b.ts);

    // Sliding-window scan.
    for (let i = 0; i < hits.length; i++) {
      const windowEnd = hits[i].ts.getTime() + WINDOW_MS;
      let count = 0;
      for (let j = i; j < hits.length && hits[j].ts.getTime() <= windowEnd; j++) {
        count++;
      }
      if (count > THRESHOLD) {
        anomalies.push({
          type:          'brute_force',
          sourceIp:      ip,
          endpoint:      hits[i].path,
          count,
          windowMinutes: 5,
          sample:        `${count} failed auth attempts from ${ip} in 5 min`,
          severity:      'high',
        });
        break; // one anomaly per IP
      }
    }
  }

  return anomalies;
}

/**
 * Detect SQL injection probes: any entry whose query string matches a known
 * injection pattern.
 *
 * @param {{ ip: string, ts: Date, path: string, qs: string }[]} entries
 * @returns {Array<{ type:string, sourceIp:string, endpoint:string, count:number,
 *                   windowMinutes:number, sample:string, severity:string }>}
 */
function detectSqlInjection(entries) {
  const anomalies = [];
  /** @type {Map<string, { count: number, sample: string, path: string }>} */
  const byIp = new Map();

  for (const e of entries) {
    if (!e.qs) continue;
    const matchedPattern = SQLI_PATTERNS.find((re) => re.test(e.qs));
    if (!matchedPattern) continue;

    if (!byIp.has(e.ip)) {
      byIp.set(e.ip, { count: 0, sample: e.qs.slice(0, 120), path: e.path });
    }
    byIp.get(e.ip).count++;
  }

  for (const [ip, data] of byIp) {
    anomalies.push({
      type:          'sql_injection',
      sourceIp:      ip,
      endpoint:      data.path,
      count:         data.count,
      windowMinutes: DEFAULT_LOOKBACK_MINUTES,
      sample:        data.sample,
      severity:      'high',
    });
  }

  return anomalies;
}

/**
 * Detect path scanning: >50 HTTP 404s from the same IP in any 10-minute window.
 *
 * @param {{ ip: string, ts: Date, path: string, status: number }[]} entries
 * @returns {Array<{ type:string, sourceIp:string, endpoint:string, count:number,
 *                   windowMinutes:number, sample:string, severity:string }>}
 */
function detectPathScanning(entries) {
  const WINDOW_MS  = 10 * 60 * 1000;
  const THRESHOLD  = 50;
  const anomalies  = [];

  const notFound = entries.filter((e) => e.status === 404);

  const byIp = new Map();
  for (const e of notFound) {
    if (!byIp.has(e.ip)) byIp.set(e.ip, []);
    byIp.get(e.ip).push(e);
  }

  for (const [ip, hits] of byIp) {
    hits.sort((a, b) => a.ts - b.ts);

    for (let i = 0; i < hits.length; i++) {
      const windowEnd = hits[i].ts.getTime() + WINDOW_MS;
      let count = 0;
      for (let j = i; j < hits.length && hits[j].ts.getTime() <= windowEnd; j++) {
        count++;
      }
      if (count > THRESHOLD) {
        anomalies.push({
          type:          'path_scanning',
          sourceIp:      ip,
          endpoint:      hits[i].path,
          count,
          windowMinutes: 10,
          sample:        `${count} 404s from ${ip} in 10 min`,
          severity:      'medium',
        });
        break; // one anomaly per IP
      }
    }
  }

  return anomalies;
}

/**
 * Detect known malicious scanner User-Agents (sqlmap, nikto).
 *
 * @param {{ ip: string, path: string, ua: string }[]} entries
 * @returns {Array<{ type:string, sourceIp:string, endpoint:string, count:number,
 *                   windowMinutes:number, sample:string, severity:string }>}
 */
function detectScannerAgents(entries) {
  const anomalies = [];
  /** @type {Map<string, { count: number, path: string, ua: string }>} */
  const byIpUa = new Map();

  for (const e of entries) {
    const uaLower = e.ua.toLowerCase();
    const matched = SCANNER_UA_PATTERNS.find((p) => uaLower.includes(p));
    if (!matched) continue;

    const key = `${e.ip}:${matched}`;
    if (!byIpUa.has(key)) {
      byIpUa.set(key, { count: 0, path: e.path, ua: e.ua.slice(0, 120) });
    }
    byIpUa.get(key).count++;
  }

  for (const [key, data] of byIpUa) {
    const [ip] = key.split(':');
    anomalies.push({
      type:          'scanner_agent',
      sourceIp:      ip,
      endpoint:      data.path,
      count:         data.count,
      windowMinutes: DEFAULT_LOOKBACK_MINUTES,
      sample:        data.ua,
      severity:      'high',
    });
  }

  return anomalies;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{
 *   summary: string,
 *   anomalies: Array<{ type:string, sourceIp:string, endpoint:string, count:number,
 *                       windowMinutes:number, sample:string, severity:string }>,
 *   errorRatePercent: number,
 *   totalRequests: number,
 *   checked_at: string
 * }>}
 */
async function handler() {
  const checked_at = new Date().toISOString();

  if (!sshBackend.isConnected()) {
    throw new Error('SSH not connected — cannot read access log');
  }

  const { appliance } = getConfig();
  const toolCfg        = appliance.tools?.access_log_scan ?? {};
  const logPath        = toolCfg.log_path        ?? DEFAULT_LOG_PATH;
  const lookbackMin    = toolCfg.lookback_minutes ?? DEFAULT_LOOKBACK_MINUTES;

  // ── 1. Tail the log over SSH ──────────────────────────────────────────────
  //
  // We read the entire log file and filter by timestamp client-side to avoid
  // shell injection. The file path comes from config, not from user input.
  // `cat` is the simplest safe read — no interpolated arguments.
  //
  // For large logs, `tail -n 100000` is a pragmatic upper bound that covers
  // any realistic lookback window without streaming the full history.
  const CMD_READ = `tail -n 100000 "${logPath}" 2>/dev/null || true`;
  log.info(`Reading access log: ${logPath}`);

  const result = await sshBackend.exec(CMD_READ);

  // A missing log file is non-fatal — return an empty result.
  if (!result.stdout || result.stdout.trim() === '') {
    log.warn(`Access log empty or not found: ${logPath}`);
    return {
      summary:          'No access log data available.',
      anomalies:        [],
      errorRatePercent: 0,
      totalRequests:    0,
      checked_at,
    };
  }

  // ── 2. Parse and filter by lookback window ────────────────────────────────
  const cutoff   = new Date(Date.now() - lookbackMin * 60 * 1000);
  const allLines = result.stdout.split('\n');
  const entries  = [];

  for (const line of allLines) {
    const parsed = parseLine(line.trim());
    if (parsed && parsed.ts >= cutoff) entries.push(parsed);
  }

  log.info(`Parsed ${entries.length} entries within lookback window (${lookbackMin} min)`);

  // ── 3. Run detectors ──────────────────────────────────────────────────────
  const anomalies = [
    ...detectBruteForce(entries),
    ...detectSqlInjection(entries),
    ...detectPathScanning(entries),
    ...detectScannerAgents(entries),
  ];

  // ── 4. Compute metrics ────────────────────────────────────────────────────
  const totalRequests    = entries.length;
  const errorCount       = entries.filter((e) => e.status >= 400).length;
  const errorRatePercent =
    totalRequests > 0 ? Math.round((errorCount / totalRequests) * 1000) / 10 : 0;

  const summary =
    anomalies.length === 0
      ? `No anomalies detected in ${totalRequests} requests over the past ${lookbackMin} minutes.`
      : `${anomalies.length} anomaly(ies) detected in ${totalRequests} requests (${errorRatePercent}% error rate).`;

  log.info(summary);

  return {
    summary,
    anomalies,
    errorRatePercent,
    totalRequests,
    checked_at,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { name: NAME, schema: SCHEMA, handler, riskLevel: RISK_LEVEL };
