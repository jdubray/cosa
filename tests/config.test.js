'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

// Keep a reference before any mocking
const { _resetConfig, getConfig } = require('../config/cosa.config');

const VALID_ENV = {
  ANTHROPIC_API_KEY:      'sk-ant-test',
  COSA_EMAIL_ADDRESS:     'cosa@example.com',
  COSA_EMAIL_IMAP_HOST:   'imap.example.com',
  COSA_EMAIL_IMAP_PORT:   '993',
  COSA_EMAIL_SMTP_HOST:   'smtp.example.com',
  COSA_EMAIL_SMTP_PORT:   '587',
  COSA_EMAIL_USERNAME:    'cosa@example.com',
  COSA_EMAIL_APP_PASSWORD:'test-app-password',
};

const VALID_YAML = `
appliance:
  name: "Test POS"
  timezone: "UTC"
ssh:
  host: "192.168.1.10"
  port: 22
  user: "baanbaan"
  key_path: "/home/cosa/.ssh/id_test"
operator:
  email: "owner@example.com"
  approval_timeout_minutes: 30
`;

/**
 * Write a temporary appliance.yaml and set process.cwd() to its directory.
 * Returns a cleanup function.
 *
 * @param {string} yamlContent
 * @returns {{ tmpDir: string, cleanup: () => void }}
 */
function setupTmpConfig(yamlContent) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosa-test-'));
  fs.mkdirSync(path.join(tmpDir, 'config'));
  fs.writeFileSync(path.join(tmpDir, 'config', 'appliance.yaml'), yamlContent, 'utf8');

  const originalCwd = process.cwd;
  process.cwd = () => tmpDir;

  return {
    tmpDir,
    cleanup() {
      process.cwd = originalCwd;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

/**
 * Set environment variables from a plain object, returning a restore function.
 *
 * @param {Record<string, string>} vars
 * @returns {() => void} restore function
 */
function setEnv(vars) {
  const saved = {};
  const keys = Object.keys(vars);
  keys.forEach(k => { saved[k] = process.env[k]; process.env[k] = vars[k]; });
  return () => keys.forEach(k => {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  });
}

/**
 * Delete environment variables, returning a restore function.
 *
 * @param {string[]} keys
 * @returns {() => void} restore function
 */
function unsetEnv(keys) {
  const saved = {};
  keys.forEach(k => { saved[k] = process.env[k]; delete process.env[k]; });
  return () => keys.forEach(k => {
    if (saved[k] !== undefined) process.env[k] = saved[k];
  });
}

beforeEach(() => {
  _resetConfig();
});

// ---------------------------------------------------------------------------
// Acceptance criteria 1 & 4: reads appliance.yaml + .env; exposes singleton
// ---------------------------------------------------------------------------

describe('getConfig() — happy path', () => {
  it('returns a config object with env and appliance sections', () => {
    const restoreEnv = setEnv(VALID_ENV);
    const { cleanup } = setupTmpConfig(VALID_YAML);

    try {
      const config = getConfig();
      expect(config).toHaveProperty('env');
      expect(config).toHaveProperty('appliance');
    } finally {
      cleanup();
      restoreEnv();
    }
  });

  it('exposes anthropicApiKey from env', () => {
    const restoreEnv = setEnv(VALID_ENV);
    const { cleanup } = setupTmpConfig(VALID_YAML);

    try {
      const { env } = getConfig();
      expect(env.anthropicApiKey).toBe('sk-ant-test');
    } finally {
      cleanup();
      restoreEnv();
    }
  });

  it('exposes parsed email config with numeric ports', () => {
    const restoreEnv = setEnv(VALID_ENV);
    const { cleanup } = setupTmpConfig(VALID_YAML);

    try {
      const { env } = getConfig();
      expect(env.email.imapPort).toBe(993);
      expect(env.email.smtpPort).toBe(587);
    } finally {
      cleanup();
      restoreEnv();
    }
  });

  it('exposes appliance yaml fields', () => {
    const restoreEnv = setEnv(VALID_ENV);
    const { cleanup } = setupTmpConfig(VALID_YAML);

    try {
      const { appliance } = getConfig();
      expect(appliance.ssh.host).toBe('192.168.1.10');
      expect(appliance.operator.email).toBe('owner@example.com');
    } finally {
      cleanup();
      restoreEnv();
    }
  });

  it('returns the same object on repeated calls (singleton)', () => {
    const restoreEnv = setEnv(VALID_ENV);
    const { cleanup } = setupTmpConfig(VALID_YAML);

    try {
      const a = getConfig();
      const b = getConfig();
      expect(a).toBe(b);
    } finally {
      cleanup();
      restoreEnv();
    }
  });
});

// ---------------------------------------------------------------------------
// Acceptance criteria 2 & 3: missing fields → descriptive error
// ---------------------------------------------------------------------------

describe('getConfig() — missing env vars', () => {
  it('throws when ANTHROPIC_API_KEY is absent', () => {
    const restoreEnv = setEnv(VALID_ENV);
    const unset = unsetEnv(['ANTHROPIC_API_KEY']);
    const { cleanup } = setupTmpConfig(VALID_YAML);

    try {
      expect(() => getConfig()).toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      cleanup();
      unset();
      restoreEnv();
    }
  });

  it('throws when multiple email vars are absent', () => {
    const restoreEnv = setEnv(VALID_ENV);
    const unset = unsetEnv(['COSA_EMAIL_IMAP_HOST', 'COSA_EMAIL_APP_PASSWORD']);
    const { cleanup } = setupTmpConfig(VALID_YAML);

    try {
      expect(() => getConfig()).toThrow(/COSA_EMAIL_IMAP_HOST/);
    } finally {
      cleanup();
      unset();
      restoreEnv();
    }
  });

  it('error message mentions .env.example', () => {
    const restoreEnv = setEnv(VALID_ENV);
    const unset = unsetEnv(['ANTHROPIC_API_KEY']);
    const { cleanup } = setupTmpConfig(VALID_YAML);

    try {
      expect(() => getConfig()).toThrow(/.env.example/);
    } finally {
      cleanup();
      unset();
      restoreEnv();
    }
  });
});

describe('getConfig() — missing appliance.yaml fields', () => {
  it('throws when ssh.host is absent', () => {
    const restoreEnv = setEnv(VALID_ENV);
    const badYaml = VALID_YAML.replace('host: "192.168.1.10"', '');
    const { cleanup } = setupTmpConfig(badYaml);

    try {
      expect(() => getConfig()).toThrow(/ssh\.host/);
    } finally {
      cleanup();
      restoreEnv();
    }
  });

  it('throws when operator.email is absent', () => {
    const restoreEnv = setEnv(VALID_ENV);
    const badYaml = VALID_YAML.replace('email: "owner@example.com"', '');
    const { cleanup } = setupTmpConfig(badYaml);

    try {
      expect(() => getConfig()).toThrow(/operator\.email/);
    } finally {
      cleanup();
      restoreEnv();
    }
  });
});

describe('getConfig() — missing appliance.yaml file', () => {
  it('throws a descriptive error when the file does not exist', () => {
    const restoreEnv = setEnv(VALID_ENV);
    // Use a tmp dir with no config/ subdirectory
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosa-noconfig-'));
    const originalCwd = process.cwd;
    process.cwd = () => tmpDir;

    try {
      expect(() => getConfig()).toThrow(/appliance\.yaml/);
    } finally {
      process.cwd = originalCwd;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      restoreEnv();
    }
  });
});
