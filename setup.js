'use strict';

/**
 * COSA Setup Wizard
 *
 * Interactive setup for first-time configuration. Walks the operator through
 * connecting to Baanbaan, configuring email, and verifying everything works.
 *
 * Usage:
 *   npm run setup
 *
 * Requires Node.js >= 20. No external dependencies — uses only built-in modules
 * plus js-yaml (already a project dependency).
 */

const readline       = require('readline');
const fs             = require('fs');
const path           = require('path');
const http           = require('http');
const https          = require('https');
const { execSync }   = require('child_process');

// ---------------------------------------------------------------------------
// Terminal helpers
// ---------------------------------------------------------------------------

const B    = '\x1b[1m';       // bold
const DIM  = '\x1b[2m';       // dim
const G    = '\x1b[32m';      // green
const Y    = '\x1b[33m';      // yellow
const R    = '\x1b[31m';      // red
const C    = '\x1b[36m';      // cyan
const RST  = '\x1b[0m';       // reset

const print  = (msg = '')        => process.stdout.write(msg + '\n');
const blank  = ()                => print();
const hr     = ()                => print('─'.repeat(60));
const ok     = msg               => print(`  ${G}✓${RST}  ${msg}`);
const warn   = msg               => print(`  ${Y}!${RST}  ${msg}`);
const fail   = msg               => print(`  ${R}✗${RST}  ${msg}`);
const indent = msg               => print(`     ${DIM}${msg}${RST}`);
const step   = (n, total, title) => { blank(); print(`${B}[${n}/${total}]  ${title}${RST}`); hr(); };

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

/**
 * Ask a question and return the trimmed answer.
 * If the user presses Enter with no input, returns defaultVal (if provided).
 *
 * @param {string} question
 * @param {string} [defaultVal]
 * @returns {Promise<string>}
 */
function ask(question, defaultVal) {
  const hint = defaultVal ? `  ${DIM}(default: ${defaultVal})${RST}` : '';
  return new Promise(resolve => {
    rl.question(`\n  ${question}${hint}\n  > `, answer => {
      resolve(answer.trim() || defaultVal || '');
    });
  });
}

/**
 * Ask a yes/no question. Returns true for yes.
 *
 * @param {string} question
 * @param {boolean} [defaultYes=true]
 * @returns {Promise<boolean>}
 */
async function confirm(question, defaultYes = true) {
  const hint = defaultYes ? 'YES/no' : 'yes/NO';
  const answer = await ask(`${question} (${hint})`, defaultYes ? 'yes' : 'no');
  return answer.toLowerCase().startsWith('y');
}

/**
 * Ask for a secret (password / API key). Input is hidden using stty.
 * Falls back to normal input if stty is not available.
 *
 * @param {string} question
 * @returns {Promise<string>}
 */
function askSecret(question) {
  return new Promise(resolve => {
    print(`\n  ${question}`);

    // Suppress readline's own echo by overriding its internal write method.
    // Using stty -echo / stty echo corrupts the terminal on Windows because
    // readline runs in raw mode and manages echo itself — calling stty echo
    // afterwards leaves both the terminal AND readline echoing, doubling every
    // character typed in all subsequent prompts.
    const originalWrite = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (str) => {
      // Allow only the newline when Enter is pressed; suppress echoed characters.
      if (str === '\r\n' || str === '\n') originalWrite('\n');
    };

    rl.question('  > ', answer => {
      rl._writeToOutput = originalWrite;
      print('');   // move to a fresh line after hidden input
      resolve(answer.trim());
    });
  });
}

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

/**
 * HTTP GET, returns { status, body } where body is parsed JSON or raw string.
 *
 * @param {string} url
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<{ status: number, body: any }>}
 */
function httpGet(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, res => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Connection timed out')); });
  });
}

/**
 * HTTP POST with JSON body.
 *
 * @param {string} url
 * @param {object} data
 * @param {number} [timeoutMs=8000]
 * @returns {Promise<{ status: number, body: any }>}
 */
function httpPost(url, data, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const body    = JSON.stringify(data);
    const parsed  = new URL(url);
    const options = {
      hostname : parsed.hostname,
      port     : parsed.port || 80,
      path     : parsed.pathname,
      method   : 'POST',
      headers  : {
        'Content-Type'  : 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    };
    const req = http.request(options, res => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Connection timed out')); });
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// SSH key helpers
// ---------------------------------------------------------------------------

const SSH_DIR      = path.join(process.env.HOME || '/root', '.ssh');
const SSH_KEY_PATH = path.join(SSH_DIR, 'id_ed25519_cosa');
const SSH_KEY_PUB  = SSH_KEY_PATH + '.pub';

/** Generate a new ED25519 key pair for COSA → Baanbaan communication. */
function generateSshKey() {
  fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
  execSync(
    `ssh-keygen -t ed25519 -f "${SSH_KEY_PATH}" -N "" -C "cosa@$(hostname)" -q`,
    { stdio: 'pipe' }
  );
}

/** Read the public key. */
function getSshPublicKey() {
  return fs.readFileSync(SSH_KEY_PUB, 'utf8').trim();
}

/**
 * Test that SSH works against the appliance using the COSA key.
 *
 * @param {string} user
 * @param {string} host
 * @returns {boolean}
 */
function testSshConnection(user, host) {
  try {
    execSync(
      `ssh -i "${SSH_KEY_PATH}" ` +
      `-o StrictHostKeyChecking=no ` +
      `-o ConnectTimeout=5 ` +
      `-o BatchMode=yes ` +
      `${user}@${host} echo ok`,
      { stdio: 'pipe', timeout: 8000 }
    );
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Anthropic API key verification
// ---------------------------------------------------------------------------

/**
 * Verify an Anthropic API key by making a minimal Messages API call.
 *
 * @param {string} apiKey
 * @returns {Promise<boolean>}
 */
function verifyAnthropicKey(apiKey) {
  const body = JSON.stringify({
    model       : 'claude-haiku-4-5-20251001',
    max_tokens  : 5,
    messages    : [{ role: 'user', content: 'hi' }],
  });

  return new Promise(resolve => {
    const req = https.request({
      hostname : 'api.anthropic.com',
      path     : '/v1/messages',
      method   : 'POST',
      headers  : {
        'x-api-key'          : apiKey,
        'anthropic-version'  : '2023-06-01',
        'content-type'       : 'application/json',
        'content-length'     : Buffer.byteLength(body),
      },
      timeout: 10000,
    }, res => resolve(res.statusCode === 200));
    req.on('error',   () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Config writers
// ---------------------------------------------------------------------------

/** Write the .env file from collected values. */
function writeEnv(v) {
  const content = [
    '# Claude API',
    `ANTHROPIC_API_KEY=${v.anthropicKey}`,
    '',
    '# COSA email account (Gmail)',
    `COSA_EMAIL_ADDRESS=${v.cosaEmail}`,
    'COSA_EMAIL_IMAP_HOST=imap.gmail.com',
    'COSA_EMAIL_IMAP_PORT=993',
    'COSA_EMAIL_SMTP_HOST=smtp.gmail.com',
    'COSA_EMAIL_SMTP_PORT=587',
    `COSA_EMAIL_USERNAME=${v.cosaEmail}`,
    `COSA_EMAIL_APP_PASSWORD=${v.appPassword}`,
    '',
    '# Internal',
    'COSA_DATA_DIR=./data',
    'COSA_LOG_LEVEL=info',
    'NODE_ENV=production',
    '',
    '# Communication style: simple = plain language, advanced = technical detail',
    `COSA_OPERATOR_MODE=${v.operatorMode}`,
    '',
  ].join('\n');
  fs.writeFileSync('.env', content);
}

/** Write config/appliance.yaml from collected values. */
function writeApplianceYaml(v) {
  // The dangerous_commands patterns use regex syntax — backslashes must be
  // escaped once for YAML double-quoted strings (\\s → literal \s in the regex).
  const content = `# config/appliance.yaml
# Generated by COSA setup — ${new Date().toISOString()}
appliance:
  name: "${v.applianceName}"
  timezone: "${v.timezone}"

ssh:
  host: "${v.applianceIp}"
  port: 22
  user: "${v.sshUser}"
  key_path: "${SSH_KEY_PATH}"
  host_key_fingerprint: "${v.hostKeyFingerprint}"
  connect_timeout_ms: 5000
  command_timeout_ms: 30000

appliance_api:
  base_url: "http://${v.applianceIp}:${v.appliancePort}"
  health_endpoint: "/health"
  health_ready_endpoint: "/health/ready"
  request_timeout_ms: 10000

database:
  path: "${v.dbPath}"
  read_only: true

process_supervisor:
  type: "systemd"
  service_name: "${v.serviceName}"

operator:
  email: "${v.operatorEmail}"
  name: "${v.operatorName}"
  approval_timeout_minutes: 30
  urgent_approval_timeout_minutes: 5

cron:
  health_check: "0 * * * *"

tools:
  health_check:
    enabled: true
    http_check: true
    process_check: true
    ssh_connectivity_check: true
  db_query:
    enabled: true
    max_row_return: 100
    query_timeout_ms: 15000
  db_integrity:
    enabled: true
    run_wal_checkpoint: true

security:
  dangerous_commands:
    - pattern: "rm\\\\s+-rf"
      reason: "Recursive delete"
    - pattern: "DROP\\\\s+TABLE"
      reason: "Destructive SQL"
    - pattern: "DROP\\\\s+DATABASE"
      reason: "Destructive SQL"
    - pattern: "DELETE\\\\s+FROM\\\\s+\\\\w+\\\\s*;"
      reason: "Unscoped delete (no WHERE clause)"
    - pattern: "killall|pkill|kill\\\\s+-9"
      reason: "Process kill"
    - pattern: "systemctl\\\\s+(stop|disable|mask)"
      reason: "Service stop"
    - pattern: "dd\\\\s+if="
      reason: "Raw disk operation"
    - pattern: "chmod\\\\s+777"
      reason: "Insecure permission set"
    - pattern: "curl.*\\\\|\\\\s*(bash|sh)"
      reason: "Remote code execution via pipe"
    - pattern: "(AWS_SECRET|API_KEY|PASSWORD|TOKEN)\\\\s*="
      reason: "Potential credential exposure"
`;
  fs.writeFileSync('config/appliance.yaml', content);
}

/** Write config/APPLIANCE.md from collected values. */
function writeApplianceMd(v) {
  const content = `# ${v.applianceName} Appliance — Identity

**System:** ${v.applianceName}
**Runtime:** ${v.runtime}
**OS:** ${v.os}
**Deploy path:** ${v.deployPath}
**Database:** SQLite at ${v.dbPath}
**Process supervisor:** systemd (service name: ${v.serviceName})
**API:** HTTP on port ${v.appliancePort}
**External POS:** ${v.posAdapter}

## Network
**LAN IP:** ${v.applianceIp}
**Router:** (your router)

## Contacts
**Operator:** ${v.operatorEmail}

## Known State
Last verified healthy: (COSA will update this field after each health check)
`;
  fs.writeFileSync('config/APPLIANCE.md', content);
}

// ---------------------------------------------------------------------------
// Main setup flow
// ---------------------------------------------------------------------------

async function main() {
  // ── Welcome ────────────────────────────────────────────────────────────────

  print();
  print(`${B}${C}╔═══════════════════════════════════════════════════════════╗${RST}`);
  print(`${B}${C}║                  Welcome to COSA Setup                   ║${RST}`);
  print(`${B}${C}╚═══════════════════════════════════════════════════════════╝${RST}`);
  blank();
  print('  This wizard will get COSA up and running in about 5 minutes.');
  print('  It will:');
  blank();
  indent('→  Connect to your Baanbaan system');
  indent('→  Set up a secure private channel between COSA and Baanbaan');
  indent('→  Configure your email so you can receive alerts');
  indent('→  Connect COSA\'s AI brain (Anthropic Claude)');
  indent('→  Run a first health check to confirm everything is working');
  blank();
  print(`  ${DIM}Press Ctrl+C at any time to quit without saving.${RST}`);
  blank();

  const TOTAL = 6;
  const v     = {};   // collects all config values

  // ── Step 1: Find Baanbaan ──────────────────────────────────────────────────

  step(1, TOTAL, 'Finding your Baanbaan system');
  blank();
  print('  Looking for Baanbaan on your network...');
  blank();

  let applianceInfo = null;
  let applianceHost = null;   // hostname or IP used to connect

  // Try mDNS hostname first (works if Baanbaan has avahi/bonjour enabled)
  const mdnsHosts = ['baanbaan.local', 'baanbaan'];
  for (const host of mdnsHosts) {
    try {
      const res = await httpGet(`http://${host}:3000/setup/info`, 3000);
      if (res.status === 200 && res.body?.appliance) {
        applianceInfo = res.body;
        applianceHost = host;
        break;
      }
    } catch { /* not found on this hostname */ }
  }

  if (applianceInfo) {
    ok(`Found automatically at ${applianceHost}`);
  } else {
    warn('Could not find Baanbaan automatically.');
    blank();
    print('  Let\'s find it manually. You\'ll need the IP address of your Baanbaan device.');
    blank();
    indent('Where to find it:');
    indent('  • Look at your router\'s admin page for a device called "baanbaan"');
    indent('  • Or check the Baanbaan device screen if it\'s connected to a monitor');
    indent('  • It usually looks like  192.168.1.10  or  10.0.0.xx');
    blank();

    for (let attempt = 1; attempt <= 3; attempt++) {
      const ip = await ask('Baanbaan IP address');
      if (!ip) continue;

      print(`\n  Connecting to ${ip}...`);
      try {
        const res = await httpGet(`http://${ip}:3000/setup/info`, 6000);
        if (res.status === 200 && res.body?.appliance) {
          applianceInfo = res.body;
          applianceHost = ip;
          ok('Connected!');
          break;
        } else {
          fail(`Reached something at ${ip} but it doesn't look like a Baanbaan system.`);
        }
      } catch {
        fail(`Could not reach ${ip}. Check the address and make sure Baanbaan is powered on.`);
      }

      if (attempt < 3) indent(`Attempt ${attempt}/3 — let's try again.`);
    }

    if (!applianceInfo) {
      blank();
      fail('Could not connect to Baanbaan after 3 attempts.');
      print('  Make sure Baanbaan is powered on and connected to your network,');
      print('  then run  npm run setup  again.');
      process.exit(1);
    }
  }

  // Populate values from what the appliance told us
  v.applianceName      = applianceInfo.appliance.name;
  v.applianceIp        = applianceInfo.network?.lan_ip ?? applianceHost;
  v.appliancePort      = applianceInfo.appliance.api_port   ?? 3000;
  v.timezone           = applianceInfo.appliance.timezone   ?? 'America/New_York';
  v.dbPath             = applianceInfo.database.path;
  v.serviceName        = applianceInfo.process_supervisor.service_name;
  v.sshUser            = applianceInfo.ssh.user;
  v.hostKeyFingerprint = applianceInfo.ssh.host_key_fingerprint;
  v.runtime            = applianceInfo.appliance.runtime    ?? 'Bun';
  v.os                 = applianceInfo.appliance.os         ?? 'Raspberry Pi OS';
  v.deployPath         = applianceInfo.appliance.deploy_path;
  v.posAdapter         = applianceInfo.appliance.pos_adapter ?? 'Clover';

  blank();
  print(`  ${B}System found:${RST}`);
  indent(`Name:     ${v.applianceName}`);
  indent(`Address:  ${v.applianceIp}:${v.appliancePort}`);
  indent(`Timezone: ${v.timezone}`);
  indent(`Version:  ${applianceInfo.appliance.version ?? 'unknown'}`);

  // ── Step 2: Secure channel (SSH key) ──────────────────────────────────────

  step(2, TOTAL, 'Setting up a secure private channel');
  blank();
  print('  COSA communicates with Baanbaan over an encrypted private channel (SSH).');
  print('  We\'ll generate a key for this COSA device and register it with Baanbaan.');
  blank();

  // Generate key if needed
  if (fs.existsSync(SSH_KEY_PATH)) {
    ok('A key for this device already exists — reusing it.');
  } else {
    print('  Generating key...');
    try {
      generateSshKey();
      ok('Key generated.');
    } catch (e) {
      fail(`Could not generate key: ${e.message}`);
      print('  Make sure  ssh-keygen  is installed (it usually is on Raspberry Pi OS).');
      process.exit(1);
    }
  }

  const publicKey = getSshPublicKey();

  // Register key using the Baanbaan setup PIN
  blank();
  print('  To authorise this connection, enter the 6-digit setup PIN from your Baanbaan device.');
  blank();
  indent('Where to find it:');
  indent('  • On the Baanbaan screen under  "COSA Setup PIN"');
  indent('  • Or in the welcome email you received when Baanbaan was installed');
  indent('  • The PIN changes every 24 hours — generate a fresh one if yours has expired');
  blank();

  let keyRegistered = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const pin = await askSecret('Setup PIN (6 digits)');
    if (!pin) continue;

    print('\n  Registering...');
    try {
      const res = await httpPost(
        `http://${v.applianceIp}:${v.appliancePort}/setup/register-ssh-key`,
        { public_key: publicKey, pin },
        8000
      );
      if (res.status === 200) {
        keyRegistered = true;
        ok('Channel authorised.');
        break;
      } else if (res.status === 401) {
        fail(`Incorrect PIN (attempt ${attempt}/3).`);
        if (attempt < 3) indent('Try again, or generate a new PIN on the Baanbaan device.');
      } else if (res.status === 410) {
        fail('The setup PIN has expired.');
        indent('Generate a new 6-digit PIN on the Baanbaan device and try again.');
        break;
      } else if (res.status === 409) {
        ok('This COSA device is already registered with Baanbaan.');
        keyRegistered = true;
        break;
      } else {
        fail(`Unexpected response (${res.status}). Check Baanbaan is running normally.`);
      }
    } catch (e) {
      fail(`Connection error: ${e.message}`);
    }
  }

  if (!keyRegistered) {
    blank();
    fail('Could not register the secure channel.');
    print('  Generate a fresh PIN on the Baanbaan device and run  npm run setup  again.');
    process.exit(1);
  }

  // Brief pause then verify SSH works
  blank();
  print('  Verifying connection...');
  // Give Baanbaan a moment to write the authorized_keys file
  await new Promise(r => setTimeout(r, 2000));
  if (testSshConnection(v.sshUser, v.applianceIp)) {
    ok('Secure channel verified — COSA can reach Baanbaan.');
  } else {
    warn('Could not verify SSH yet — it may need a few seconds to activate.');
    indent('COSA will retry automatically when it starts.');
  }

  // ── Step 3: Who receives alerts ────────────────────────────────────────────

  step(3, TOTAL, 'Who should receive COSA\'s emails?');
  blank();
  print('  COSA will send you alerts when something needs attention,');
  print('  and you can email COSA questions at any time.');
  blank();

  v.operatorName = await ask('Your name', 'Restaurant Manager');
  blank();

  let operatorEmailValid = false;
  while (!operatorEmailValid) {
    v.operatorEmail = await ask('Your email address (where COSA sends alerts)');
    if (v.operatorEmail.includes('@') && v.operatorEmail.includes('.')) {
      operatorEmailValid = true;
    } else {
      fail('That doesn\'t look like a valid email address. Please try again.');
    }
  }

  blank();
  ok(`Alerts will be sent to: ${v.operatorEmail}`);

  // ── Step 4: COSA's email account ───────────────────────────────────────────

  step(4, TOTAL, 'Setting up COSA\'s email account (Gmail)');
  blank();
  print('  COSA needs its own email address to send messages and receive your replies.');
  print('  You should have already created a dedicated Gmail account for COSA');
  print(`  (e.g.  ${DIM}cosa.myrestaurant@gmail.com${RST})  and set up an App Password.`);
  blank();
  indent(`If you haven't done this yet, follow the Gmail Setup guide in README.md,`);
  indent(`then come back and run  npm run setup  again.`);
  blank();

  let cosaEmailValid = false;
  while (!cosaEmailValid) {
    v.cosaEmail = await ask('COSA\'s Gmail address');
    if (v.cosaEmail.includes('@')) {
      cosaEmailValid = true;
    } else {
      fail('Please enter the full Gmail address (including @gmail.com).');
    }
  }

  blank();
  print('  Now enter the 16-character App Password for that Gmail account.');
  blank();
  indent('It looks like:  abcd efgh ijkl mnop');
  indent('(Copy it exactly — spaces are fine, we\'ll remove them)');
  blank();

  let appPasswordValid = false;
  while (!appPasswordValid) {
    const raw = await askSecret('Gmail App Password');
    v.appPassword = raw.replace(/\s/g, '');
    if (v.appPassword.length === 16) {
      appPasswordValid = true;
      ok('App Password saved.');
    } else {
      fail(`App Passwords are exactly 16 characters. You entered ${v.appPassword.length}.`);
      indent('Copy the password directly from the Google Account page and try again.');
    }
  }

  // ── Step 5: Anthropic API key ──────────────────────────────────────────────

  step(5, TOTAL, 'Connecting COSA\'s AI brain (Anthropic Claude)');
  blank();
  print('  COSA uses Claude — an AI made by Anthropic — to understand your questions');
  print('  and decide what to do. You\'ll need an Anthropic API key.');
  blank();
  indent('To get one (takes about 2 minutes):');
  indent('  1. Go to  console.anthropic.com  and sign up or log in');
  indent('  2. Click  API Keys  in the left sidebar');
  indent('  3. Click  Create Key  and give it a name like "COSA"');
  indent('  4. Copy the key — it starts with  sk-ant-');
  blank();

  let anthropicValid = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    v.anthropicKey = await askSecret('Anthropic API key (starts with sk-ant-)');

    if (!v.anthropicKey.startsWith('sk-ant-')) {
      fail('Anthropic API keys start with "sk-ant-". Please check you copied the whole key.');
      continue;
    }

    blank();
    print('  Checking key...');
    if (await verifyAnthropicKey(v.anthropicKey)) {
      anthropicValid = true;
      ok('API key verified — Claude is connected.');
      break;
    } else {
      fail('That key didn\'t work. Please check it and try again.');
      indent('Make sure you copied the full key, including the  sk-ant-  prefix.');
    }
  }

  if (!anthropicValid) {
    blank();
    fail('Could not verify the Anthropic API key after 3 attempts.');
    print('  Double-check the key at  console.anthropic.com  and run  npm run setup  again.');
    process.exit(1);
  }

  // ── Step 6: Communication style ────────────────────────────────────────────

  step(6, TOTAL, 'How should COSA write its emails?');
  blank();
  print('  COSA can communicate in two styles:');
  blank();
  print(`  ${B}Simple${RST}  (recommended)`);
  indent('Plain language, no tech jargon.');
  indent('"Your system is running fine." / "Your printer has been offline for 30 minutes."');
  blank();
  print(`  ${B}Advanced${RST}  (for tech-savvy operators)`);
  indent('Full technical detail — status codes, connection logs, database metrics.');
  indent('Useful if a developer is helping you manage the system.');
  blank();

  const wantsAdvanced = await confirm('Do you want advanced technical detail in emails?', false);
  v.operatorMode = wantsAdvanced ? 'advanced' : 'simple';
  ok(`Email style set to: ${v.operatorMode}`);

  // ── Write config files ─────────────────────────────────────────────────────

  blank();
  hr();
  blank();
  print(`  ${B}Saving configuration...${RST}`);
  blank();

  try {
    writeEnv(v);
    ok('.env');
  } catch (e) {
    fail(`.env — ${e.message}`);
    process.exit(1);
  }

  try {
    writeApplianceYaml(v);
    ok('config/appliance.yaml');
  } catch (e) {
    fail(`config/appliance.yaml — ${e.message}`);
    process.exit(1);
  }

  try {
    writeApplianceMd(v);
    ok('config/APPLIANCE.md');
  } catch (e) {
    fail(`config/APPLIANCE.md — ${e.message}`);
    process.exit(1);
  }

  // Set up data directory
  fs.mkdirSync('data', { recursive: true });
  ok('data/  (database directory)');

  // ── Final health check ─────────────────────────────────────────────────────

  blank();
  print('  Running a final health check on Baanbaan...');
  try {
    const res = await httpGet(`http://${v.applianceIp}:${v.appliancePort}/health`, 8000);
    if (res.status === 200) {
      ok(`Baanbaan health check passed — ${res.body?.status ?? 'ok'}`);
    } else {
      warn(`Baanbaan responded with status ${res.status} — COSA will investigate when it starts.`);
    }
  } catch {
    warn('Could not reach Baanbaan health endpoint — check that it\'s running.');
  }

  // ── Done ───────────────────────────────────────────────────────────────────

  blank();
  hr();
  blank();
  print(`${G}${B}  Setup complete!${RST}`);
  blank();
  print('  Start COSA now with:');
  blank();
  print(`    ${B}npm start${RST}`);
  blank();
  print('  Within a couple of minutes, COSA will send a welcome email to:');
  print(`    ${C}${v.operatorEmail}${RST}`);
  blank();
  print('  From then on, just email COSA questions at:');
  print(`    ${C}${v.cosaEmail}${RST}`);
  blank();

  rl.close();
}

main().catch(e => {
  console.error(`\nSetup failed: ${e.message}`);
  process.exit(1);
});
