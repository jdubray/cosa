'use strict';

// ---------------------------------------------------------------------------
// Mocks — declared before any require() so Jest hoisting works
// ---------------------------------------------------------------------------

const mockSshIsConnected = jest.fn();
const mockSshExec        = jest.fn();
const mockChildExec      = jest.fn();

jest.mock('../../src/ssh-backend', () => ({
  isConnected: (...a) => mockSshIsConnected(...a),
  exec:        (...a) => mockSshExec(...a),
}));

// promisify(child_process.exec) treats `cb(err, value)` as resolve(value), so
// each mocked invocation must call cb(null, { stdout, stderr }) on success or
// cb(errWithFields) on non-zero exit. The errWithFields object is shaped like
// the real ChildProcess error (code, stdout, stderr, message).
jest.mock('node:child_process', () => ({
  exec: (cmd, opts, cb) => mockChildExec(cmd, opts, cb),
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

const { handler, name, riskLevel } = require('../../src/tools/auto-patch');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function sshOk(stdout = '', stderr = '') {
  return Promise.resolve({ exitCode: 0, stdout, stderr });
}
function sshFail(exitCode, stderr = 'boom') {
  return Promise.resolve({ exitCode, stdout: '', stderr });
}

function mockLocalOk(stdout = '', stderr = '') {
  mockChildExec.mockImplementationOnce((cmd, opts, cb) => {
    cb(null, { stdout, stderr });
  });
}
function mockLocalFail(exitCode, stderr = 'boom') {
  mockChildExec.mockImplementationOnce((cmd, opts, cb) => {
    const err   = new Error(`Command failed`);
    err.code    = exitCode;
    err.stdout  = '';
    err.stderr  = stderr;
    cb(err);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSshIsConnected.mockReturnValue(true);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auto_patch tool — metadata', () => {
  test('exports name and risk level', () => {
    expect(name).toBe('auto_patch');
    expect(riskLevel).toBe('destructive');
  });
});

describe('auto_patch — input validation', () => {
  test('throws on invalid target', async () => {
    await expect(handler({ target: 'mars' })).rejects.toThrow(/invalid target/i);
  });

  test('throws when target is missing', async () => {
    await expect(handler({})).rejects.toThrow(/invalid target/i);
  });

  test('throws on invalid upgradeMode', async () => {
    await expect(handler({ target: 'appliance', upgradeMode: 'wild-upgrade' }))
      .rejects.toThrow(/invalid upgradeMode/i);
  });
});

describe('auto_patch — upgradeMode wiring', () => {
  test("default mode is 'upgrade' (conservative)", async () => {
    mockSshExec
      .mockReturnValueOnce(sshOk(''))
      .mockReturnValueOnce(sshOk(''))
      .mockReturnValueOnce(sshFail(1))
      .mockReturnValueOnce(sshFail(1));

    await handler({ target: 'appliance' });

    const upgradeCmd = mockSshExec.mock.calls[1][0];
    expect(upgradeCmd).toMatch(/ upgrade$/);   // ends in plain 'upgrade'
    expect(upgradeCmd).not.toMatch(/full-upgrade/);
  });

  test("'full-upgrade' mode is propagated into the apt command", async () => {
    mockSshExec
      .mockReturnValueOnce(sshOk(''))
      .mockReturnValueOnce(sshOk(''))
      .mockReturnValueOnce(sshFail(1))
      .mockReturnValueOnce(sshFail(1));

    await handler({ target: 'appliance', upgradeMode: 'full-upgrade' });

    const upgradeCmd = mockSshExec.mock.calls[1][0];
    expect(upgradeCmd).toMatch(/ full-upgrade$/);
  });
});

describe('auto_patch — appliance path (SSH)', () => {
  test('returns ok=false when SSH not connected, without invoking commands', async () => {
    mockSshIsConnected.mockReturnValue(false);

    const result = await handler({ target: 'appliance' });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/SSH backend not connected/);
    expect(mockSshExec).not.toHaveBeenCalled();
  });

  test('happy path — no reboot needed (flag absent + initramfs older than boot)', async () => {
    mockSshExec
      .mockReturnValueOnce(sshOk('Reading package lists... Done\n'))
      .mockReturnValueOnce(sshOk('Setting up libfoo (1.0)\nSetting up libbar (2.0)\n'))
      .mockReturnValueOnce(sshFail(1))   // flag check: not present
      .mockReturnValueOnce(sshFail(1));  // initramfs check: nothing newer than boot

    const result = await handler({ target: 'appliance' });

    expect(mockSshExec).toHaveBeenCalledTimes(4);
    expect(mockSshExec.mock.calls[0][0]).toMatch(/^sudo apt-get update/);
    expect(mockSshExec.mock.calls[1][0]).toMatch(/^sudo DEBIAN_FRONTEND=noninteractive apt-get/);
    expect(mockSshExec.mock.calls[2][0]).toBe('test -f /var/run/reboot-required');
    expect(mockSshExec.mock.calls[3][0]).toMatch(/initramfs/);

    expect(result.ok).toBe(true);
    expect(result.packagesUpgraded).toBe(2);
    expect(result.rebootRequired).toBe(false);
    expect(result.rebootScheduled).toBe(false);
    expect(result.error).toBeNull();
  });

  test('Pi OS path — flag absent but initramfs newer than boot triggers reboot', async () => {
    mockSshExec
      .mockReturnValueOnce(sshOk(''))
      .mockReturnValueOnce(sshOk('Setting up linux-image-rpi-2712\n'))
      .mockReturnValueOnce(sshFail(1))               // flag absent (no update-notifier-common)
      .mockReturnValueOnce(sshOk(''))                // initramfs newer than boot → exit 0
      .mockReturnValueOnce(sshOk('Shutdown scheduled'));

    const result = await handler({ target: 'appliance' });

    expect(mockSshExec).toHaveBeenCalledTimes(5);
    expect(mockSshExec.mock.calls[3][0]).toMatch(/initramfs/);
    expect(mockSshExec.mock.calls[4][0]).toBe('sudo shutdown -r +1');
    expect(result.ok).toBe(true);
    expect(result.rebootRequired).toBe(true);
    expect(result.rebootScheduled).toBe(true);
  });

  test('reboot path — flag exists and reboot is scheduled', async () => {
    mockSshExec
      .mockReturnValueOnce(sshOk(''))
      .mockReturnValueOnce(sshOk('Setting up linux-image-generic\n'))
      .mockReturnValueOnce(sshOk(''))             // reboot flag exists
      .mockReturnValueOnce(sshOk('Shutdown scheduled'));

    const result = await handler({
      target:             'appliance',
      rebootIfRequired:   true,
      rebootDelayMinutes: 2,
    });

    expect(mockSshExec).toHaveBeenCalledTimes(4);
    expect(mockSshExec.mock.calls[3][0]).toBe('sudo shutdown -r +2');
    expect(result.ok).toBe(true);
    expect(result.rebootRequired).toBe(true);
    expect(result.rebootScheduled).toBe(true);
  });

  test('reboot path — flag exists but rebootIfRequired=false', async () => {
    mockSshExec
      .mockReturnValueOnce(sshOk(''))
      .mockReturnValueOnce(sshOk(''))
      .mockReturnValueOnce(sshOk(''));

    const result = await handler({ target: 'appliance', rebootIfRequired: false });

    expect(mockSshExec).toHaveBeenCalledTimes(3);
    expect(result.ok).toBe(true);
    expect(result.rebootRequired).toBe(true);
    expect(result.rebootScheduled).toBe(false);
  });

  test('apt-get update failure — does not run upgrade or reboot', async () => {
    mockSshExec.mockReturnValueOnce(sshFail(100, 'Could not get lock /var/lib/apt/lists/lock'));

    const result = await handler({ target: 'appliance' });

    expect(mockSshExec).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/apt-get update failed.*100/);
    expect(result.logTail).toMatch(/Could not get lock/);
  });

  test('apt-get upgrade failure — captures count of partial upgrades, no reboot', async () => {
    mockSshExec
      .mockReturnValueOnce(sshOk(''))
      .mockReturnValueOnce(sshFail(100, 'dpkg: error processing package foo'));

    const result = await handler({ target: 'appliance' });

    expect(mockSshExec).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/apt-get upgrade failed/);
    expect(result.logTail).toMatch(/dpkg: error/);
  });

  test('reboot scheduling failure — surfaces error', async () => {
    mockSshExec
      .mockReturnValueOnce(sshOk(''))
      .mockReturnValueOnce(sshOk(''))
      .mockReturnValueOnce(sshOk(''))
      .mockReturnValueOnce(sshFail(1, 'shutdown: command not found'));

    const result = await handler({ target: 'appliance' });

    expect(result.ok).toBe(false);
    expect(result.rebootScheduled).toBe(false);
    expect(result.error).toMatch(/Reboot scheduling failed/);
  });

  test('SSH exec rejects (e.g. timeout) — converted to exitCode=1, no throw', async () => {
    mockSshExec.mockRejectedValueOnce(new Error('Command timed out after 1800000ms'));

    const result = await handler({ target: 'appliance' });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/apt-get update failed/);
    expect(result.logTail).toMatch(/timed out after 1800000ms/);
  });

  test('passes APT_TIMEOUT_MS as third arg to sshBackend.exec', async () => {
    mockSshExec
      .mockReturnValueOnce(sshOk(''))
      .mockReturnValueOnce(sshOk(''))
      .mockReturnValueOnce(sshFail(1))   // flag absent
      .mockReturnValueOnce(sshFail(1));  // initramfs nothing newer

    await handler({ target: 'appliance' });

    const aptUpdateCall = mockSshExec.mock.calls[0];
    expect(aptUpdateCall[2]).toBe(30 * 60 * 1000);
  });
});

describe('auto_patch — cosa path (local)', () => {
  test('happy path — no reboot needed (flag absent + initramfs older than boot)', async () => {
    mockLocalOk('Reading package lists... Done\n');
    mockLocalOk('Setting up libfoo (1.0)\nSetting up libbar (2.0)\nSetting up libbaz (3.0)\n');
    mockLocalFail(1);   // flag check: not present
    mockLocalFail(1);   // initramfs check: nothing newer than boot

    const result = await handler({ target: 'cosa' });

    expect(mockChildExec).toHaveBeenCalledTimes(4);
    expect(mockChildExec.mock.calls[0][0]).toMatch(/^sudo apt-get update/);
    expect(mockChildExec.mock.calls[2][0]).toBe('test -f /var/run/reboot-required');
    expect(mockChildExec.mock.calls[3][0]).toMatch(/initramfs/);
    expect(result.ok).toBe(true);
    expect(result.packagesUpgraded).toBe(3);
    expect(result.rebootRequired).toBe(false);
  });

  test('Pi OS path — initramfs newer than boot triggers reboot on cosa', async () => {
    mockLocalOk('');
    mockLocalOk('Setting up linux-image-rpi-2712\n');
    mockLocalFail(1);   // flag absent
    mockLocalOk('');    // initramfs newer → exit 0 = reboot needed
    mockLocalOk('Shutdown scheduled');

    const result = await handler({ target: 'cosa' });

    expect(mockChildExec).toHaveBeenCalledTimes(5);
    expect(mockChildExec.mock.calls[3][0]).toMatch(/initramfs/);
    expect(mockChildExec.mock.calls[4][0]).toBe('sudo shutdown -r +1');
    expect(result.rebootRequired).toBe(true);
    expect(result.rebootScheduled).toBe(true);
  });

  test('apt-get update failure on cosa — captures stderr', async () => {
    mockLocalFail(100, 'E: Could not open lock file /var/lib/dpkg/lock');

    const result = await handler({ target: 'cosa' });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/apt-get update failed.*100/);
    expect(result.logTail).toMatch(/Could not open lock file/);
  });

  test('does NOT short-circuit on missing SSH for cosa target', async () => {
    mockSshIsConnected.mockReturnValue(false);
    mockLocalOk('');
    mockLocalOk('');
    mockLocalFail(1);   // flag absent
    mockLocalFail(1);   // initramfs nothing newer

    const result = await handler({ target: 'cosa' });

    expect(result.ok).toBe(true);
    expect(mockSshExec).not.toHaveBeenCalled();
  });
});
