'use strict';

const fs            = require('fs');
const os            = require('os');
const path          = require('path');
const { execFile }  = require('child_process');
const { getConfig } = require('../config/cosa.config');
const { createLogger } = require('./logger');

const log = createLogger('security-gate');

// ---------------------------------------------------------------------------
// Output sanitization patterns — hardcoded, not from appliance config
// ---------------------------------------------------------------------------

/**
 * Patterns applied by sanitizeOutput() to strip credentials from tool output
 * before it is written to the LLM conversation history.
 *
 * Each entry replaces matching text with the literal string `[REDACTED]`.
 *
 * @type {Array<{ label: string, pattern: RegExp }>}
 */
const SANITIZE_PATTERNS = [
  // Anthropic API keys  (sk-ant-api03-...)
  { label: 'Anthropic API key', pattern: /sk-ant-[A-Za-z0-9\-_]+/g },
  // Clover live payment key  (sk_live_<24+ alphanum>)
  { label: 'Clover live key',   pattern: /sk_live_[a-zA-Z0-9]{24,}/g },
  // AWS IAM access key ID  (AKIA<16 uppercase alphanum>)
  { label: 'AWS access key',    pattern: /AKIA[0-9A-Z]{16}/g },
  // Base64-encoded secrets — 40+ chars that contain at least one '+' or '/'
  // (required Base64 alphabet characters).  The lookahead ensures the matched
  // segment includes a '+' or '/', which hex SHA-256 hashes and 40-char git
  // SHAs (purely [0-9a-f]) never contain, avoiding those false positives.
  { label: 'Base64 secret',     pattern: /(?=[a-zA-Z0-9+/]*[+/])[a-zA-Z0-9+/]{40,}={0,2}/g },
  // IPv4 addresses — may appear in SSH error messages, connection strings, etc.
  // Redacted to avoid leaking internal network topology into LLM context.
  // Require each octet to be 0–255 (not just any digit run) to avoid false
  // positives on version strings like "18.1.0" that have only three parts.
  { label: 'IPv4 address',      pattern: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g },
  // Absolute Unix paths under sensitive directories.
  { label: 'Unix path',         pattern: /\/(?:home|root|etc|var|opt|tmp|proc|sys)(?:\/\S+)+/g },
  // password key=value or key: value with optional quotes  (≥8 char value)
  { label: 'password',          pattern: /password["'\s]*[:=]["'\s]*\S{8,}/gi },
  // token key=value or key: value with optional quotes  (≥16 char value)
  { label: 'token',             pattern: /token["'\s]*[:=]["'\s]*\S{16,}/gi },
  // secret=<value>  (generic credential key)
  { label: 'secret',            pattern: /secret\s*=\s*\S+/gi },
  // Bearer authorization tokens (≥40 chars) — emitted in API error responses
  { label: 'Bearer token',      pattern: /Bearer\s+[a-zA-Z0-9_\-.]{40,}/g },
  // SSH / TLS / PGP private key blocks — accidental stderr from cat ~/.ssh/*
  { label: 'Private key',       pattern: /-----BEGIN\s+[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END\s+[A-Z ]*PRIVATE KEY-----/g },
  // JWT signing secrets in common key=value / property forms
  { label: 'JWT secret',        pattern: /(?:JWT_SECRET|jwtSigningKey|signingKey|jwt[_-]?secret)\s*[:=]\s*\S+/gi },
];

// ---------------------------------------------------------------------------
// Tirith integration
// ---------------------------------------------------------------------------

const TIRITH_BIN    = path.join(os.homedir(), '.cosa', 'bin', 'tirith');
const TIRITH_CONFIG = path.join(os.homedir(), '.cosa', 'tirith.yaml');

// Tirith runtime state — populated by initTirith()
let tirithAvailable = false;
let tirithConfig    = { mode: 'block', exceptions: [] };

/**
 * Attempt to locate the Tirith binary and load its YAML config.
 * Called once during boot().  If the binary is absent, COSA falls back to
 * dangerous-cmd detection only.
 *
 * @returns {void}
 */
function initTirith() {
  if (!fs.existsSync(TIRITH_BIN)) {
    // Tirith is currently aspirational (no released binary), so absence is
    // the expected state — log at info to avoid noise in digests and journals.
    // Promote back to warn once a Tirith release exists and installation is
    // documented in setup.js.
    log.info(`Tirith binary not present at ${TIRITH_BIN}; dangerous-cmd detection is the only active scanner`);
    tirithAvailable = false;
    return;
  }

  // Load optional tirith.yaml
  if (fs.existsSync(TIRITH_CONFIG)) {
    try {
      // Require js-yaml lazily — it's an optional dependency for this path.
      // If unavailable, use defaults silently.
      const yaml = require('js-yaml');
      const raw  = fs.readFileSync(TIRITH_CONFIG, 'utf8');
      const parsed = yaml.load(raw);
      if (parsed && typeof parsed === 'object') {
        if (parsed.mode)       tirithConfig.mode       = String(parsed.mode);
        if (Array.isArray(parsed.exceptions)) {
          tirithConfig.exceptions = parsed.exceptions.map(String);
        }
      }
      log.info(`Tirith config loaded: mode=${tirithConfig.mode}, exceptions=[${tirithConfig.exceptions.join(', ')}]`);
    } catch (err) {
      log.warn(`Tirith config parse error (${TIRITH_CONFIG}): ${err.message} — using defaults`);
    }
  } else {
    log.info(`No Tirith config at ${TIRITH_CONFIG} — using defaults (mode=block, no exceptions)`);
  }

  tirithAvailable = true;
  log.info(`Tirith pre-execution scanner ready: ${TIRITH_BIN}`);
}

/**
 * Invoke the Tirith binary synchronously (via child_process.execFile with a
 * tight timeout) with the serialised tool call as stdin / argument JSON.
 *
 * Tirith exit codes:
 *   0 — clean, allow
 *   1 — threat detected
 *   other — invocation error, treated as clean (fail-open for availability)
 *
 * @param {{ tool_name: string, input: object }} toolCall
 * @returns {Promise<{ blocked: false } | { blocked: true, reason: string }>}
 */
function runTirith(toolCall) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(toolCall);
    const opts = {
      timeout: 5000,   // 5-second hard ceiling — never block execution indefinitely
      maxBuffer: 64 * 1024,
      // Strip parent secrets from Tirith's environment — it only needs PATH.
      env: { PATH: process.env.PATH },
    };

    const child = execFile(TIRITH_BIN, ['--json'], opts, (err, stdout, stderr) => {
      if (!err) {
        // Exit 0 — clean
        resolve({ blocked: false });
        return;
      }

      if (err.code === 1) {
        // Threat detected — parse reason from stdout if present
        let reason = 'Tirith threat detected';
        try {
          const parsed = JSON.parse(stdout || '{}');
          if (parsed !== null && typeof parsed === 'object' && typeof parsed.reason === 'string' && parsed.reason.length > 0) {
            reason = parsed.reason;
          }
        } catch (_) { /* ignore parse error, use default reason */ }
        resolve({ blocked: true, reason });
        return;
      }

      // Any other exit (binary crash, timeout, etc.) — fail-open
      log.warn(`Tirith invocation error (code=${err.code ?? 'timeout'}): ${err.message}`);
      resolve({ blocked: false });
    });

    if (child.stdin) {
      child.stdin.end(payload);
    } else {
      // stdin unavailable (process error before pipe was created) — fail-open so
      // tool execution is not permanently blocked by a Tirith infrastructure fault.
      log.warn('Tirith stdin unavailable — payload not delivered, treating as clean');
      resolve({ blocked: false });
    }
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check a tool call first against Tirith (when available and not in the
 * exceptions list), then against every dangerous-command pattern defined in
 * `config/appliance.yaml` under `security.dangerous_commands`.
 *
 * The entire tool input is JSON-serialised before matching so that patterns
 * embedded in nested fields are also caught.  Pattern matching is
 * case-insensitive.
 *
 * @param {{ tool_name: string, input: object }} toolCall
 * @returns {Promise<{ blocked: false }
 *           | { blocked: true, reason: string, pattern?: string }>}
 */
async function check(toolCall) {
  // ── Step 1: Tirith pre-execution scan ────────────────────────────────────
  if (tirithAvailable) {
    const toolName = toolCall.tool_name ?? '';
    const isExcepted = tirithConfig.exceptions.includes(toolName);

    if (!isExcepted) {
      const tirithResult = await runTirith(toolCall);
      if (tirithResult.blocked) {
        log.warn(`Tirith blocked tool call: ${toolName} — ${tirithResult.reason}`);
        return { blocked: true, reason: tirithResult.reason };
      }
    }
  }

  // ── Step 2: dangerous-cmd regex detection ─────────────────────────────────
  const { appliance } = getConfig();
  const dangerousCommands = appliance.security?.dangerous_commands ?? [];

  const subject = JSON.stringify(toolCall.input);

  for (const entry of dangerousCommands) {
    let regex;
    try {
      regex = new RegExp(entry.pattern, 'i');
    } catch (err) {
      // Malformed pattern in config — skip and log; don't crash the tool call.
      log.error(`[security-gate] Skipping malformed dangerous_commands pattern "${entry.pattern}": ${err.message}`);
      continue;
    }
    if (regex.test(subject)) {
      return { blocked: true, reason: entry.reason, pattern: entry.pattern };
    }
  }

  return { blocked: false };
}

/**
 * Remove known sensitive values from tool output before it enters the LLM
 * conversation context.
 *
 * Accepts strings or any JSON-serialisable value.  Always returns a string.
 *
 * @param {string | object} output - Tool output (string or JSON-serialisable).
 * @returns {string} Output with sensitive values replaced by `[REDACTED]`.
 */
function sanitizeOutput(output) {
  const str = typeof output === 'string' ? output : JSON.stringify(output);

  return SANITIZE_PATTERNS.reduce(
    (acc, { pattern }) => acc.replace(pattern, '[REDACTED]'),
    str
  );
}

module.exports = { initTirith, check, sanitizeOutput };
