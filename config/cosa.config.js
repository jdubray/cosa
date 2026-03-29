'use strict';

const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');

/**
 * Required environment variable definitions.
 * @type {Array<{key: string, description: string}>}
 */
const REQUIRED_ENV = [
  { key: 'ANTHROPIC_API_KEY', description: 'Claude API key' },
  { key: 'COSA_EMAIL_ADDRESS', description: 'COSA email address' },
  { key: 'COSA_EMAIL_IMAP_HOST', description: 'IMAP host' },
  { key: 'COSA_EMAIL_IMAP_PORT', description: 'IMAP port' },
  { key: 'COSA_EMAIL_SMTP_HOST', description: 'SMTP host' },
  { key: 'COSA_EMAIL_SMTP_PORT', description: 'SMTP port' },
  { key: 'COSA_EMAIL_USERNAME', description: 'Email username' },
  { key: 'COSA_EMAIL_APP_PASSWORD', description: 'Email app password' },
];

/**
 * Required appliance.yaml field paths (dot-notation) and descriptions.
 * @type {Array<{path: string, description: string}>}
 */
const REQUIRED_YAML = [
  { path: 'ssh.host', description: 'SSH host (appliance LAN IP)' },
  { path: 'ssh.user', description: 'SSH user on appliance' },
  { path: 'ssh.key_path', description: 'Path to SSH private key' },
  { path: 'operator.email', description: 'Operator notification email' },
];

/**
 * Retrieve a nested value from an object using dot-notation path.
 *
 * @param {object} obj - Source object.
 * @param {string} dotPath - Dot-separated key path (e.g. 'ssh.host').
 * @returns {*} The value at that path, or undefined if not found.
 */
function getNestedValue(obj, dotPath) {
  return dotPath.split('.').reduce(
    (current, key) => (current != null ? current[key] : undefined),
    obj
  );
}

/**
 * Load .env and config/appliance.yaml, validate all required fields, and
 * return a structured config object.
 *
 * @returns {{ env: object, appliance: object }}
 * @throws {Error} with a descriptive message if any required field is missing
 *   or if the appliance.yaml file cannot be found.
 */
function loadConfig() {
  // Load .env from project root (safe no-op if absent — fields validated below)
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    require('dotenv').config({ path: envPath });
  } else {
    require('dotenv').config();
  }

  // Load appliance.yaml
  const yamlPath = path.resolve(process.cwd(), 'config', 'appliance.yaml');
  if (!fs.existsSync(yamlPath)) {
    throw new Error(
      `Configuration error: config/appliance.yaml not found.\n` +
      `Expected location: ${yamlPath}\n` +
      `Copy config/appliance.yaml.example and fill in appliance-specific values.`
    );
  }
  const applianceConfig = yaml.load(fs.readFileSync(yamlPath, 'utf8'));

  // Validate required environment variables
  const missingEnv = REQUIRED_ENV.filter(({ key }) => !process.env[key]);
  if (missingEnv.length > 0) {
    const details = missingEnv
      .map(({ key, description }) => `  - ${key}  (${description})`)
      .join('\n');
    throw new Error(
      `Configuration error: Missing required environment variables:\n${details}\n` +
      `Copy .env.example to .env and fill in the missing values.`
    );
  }

  // Validate required appliance.yaml fields
  const missingYaml = REQUIRED_YAML.filter(({ path: p }) => {
    const value = getNestedValue(applianceConfig, p);
    return value == null || value === '';
  });
  if (missingYaml.length > 0) {
    const details = missingYaml
      .map(({ path: p, description }) => `  - ${p}  (${description})`)
      .join('\n');
    throw new Error(
      `Configuration error: Missing required fields in config/appliance.yaml:\n${details}`
    );
  }

  return {
    env: {
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      email: {
        address:     process.env.COSA_EMAIL_ADDRESS,
        imapHost:    process.env.COSA_EMAIL_IMAP_HOST,
        imapPort:    parseInt(process.env.COSA_EMAIL_IMAP_PORT, 10),
        smtpHost:    process.env.COSA_EMAIL_SMTP_HOST,
        smtpPort:    parseInt(process.env.COSA_EMAIL_SMTP_PORT, 10),
        username:    process.env.COSA_EMAIL_USERNAME,
        appPassword: process.env.COSA_EMAIL_APP_PASSWORD,
      },
      dataDir:  process.env.COSA_DATA_DIR  || './data',
      logLevel: process.env.COSA_LOG_LEVEL || 'info',
      nodeEnv:  process.env.NODE_ENV       || 'development',
    },
    appliance: applianceConfig,
  };
}

/** @type {{ env: object, appliance: object } | null} */
let _config = null;

/**
 * Return the singleton config object, loading and validating it on first call.
 *
 * @returns {{ env: object, appliance: object }}
 * @throws {Error} if any required field is missing or appliance.yaml is absent.
 */
function getConfig() {
  if (_config === null) {
    _config = loadConfig();
  }
  return _config;
}

/**
 * Reset the config singleton.
 * **For use in tests only.** Do not call in production code.
 */
function _resetConfig() {
  _config = null;
}

module.exports = { getConfig, _resetConfig };
