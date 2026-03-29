'use strict';

// ---------------------------------------------------------------------------
// Mock: ssh2
//
// Variables starting with 'mock' are exempted from Jest's hoisting TDZ rule,
// so they can be referenced inside jest.mock() factory bodies.
// ---------------------------------------------------------------------------

/**
 * Mutable state object that controls mock SSH client behaviour.
 * Tests mutate this in beforeEach / per-test setup.
 */
const mockSsh = {
  /** 'success' | 'error' */
  connectResult: 'success',
  /** 'success' | 'error' | 'timeout' */
  execResult:    'success',
  stdout:        '',
  stderr:        '',
  exitCode:      0,
  /** Holds the most recently created MockClient instance */
  lastClient:    null,
  /** Options passed to the most recent connect() call */
  lastConnectOptions: null,
  /**
   * Host key Buffer delivered to hostVerifier during connection.
   * null → use a default 32-byte buffer of 0x42 bytes.
   */
  mockHostKey: null,
};

/** Holds the stream from the most recent exec() call so tests can inspect it. */
let mockLastStream = null;

jest.mock('ssh2', () => {
  const { EventEmitter } = require('events');

  class MockClient extends EventEmitter {
    connect(opts) {
      mockSsh.lastConnectOptions = opts;
      mockSsh.lastClient = this;

      // Use Promise microtask queue so the event fires even under fake timers.
      if (mockSsh.connectResult === 'error') {
        Promise.resolve().then(() => this.emit('error', new Error('ECONNREFUSED mock')));
        return;
      }

      // Simulate host-key exchange: invoke hostVerifier if provided.
      if (opts && opts.hostVerifier) {
        const key = mockSsh.mockHostKey ?? Buffer.alloc(32, 0x42);
        const accepted = opts.hostVerifier(key);
        if (!accepted) {
          Promise.resolve().then(() =>
            this.emit('error', new Error('Host key verification failed'))
          );
          return;
        }
      }

      Promise.resolve().then(() => this.emit('ready'));
    }

    exec(command, cb) {
      if (mockSsh.execResult === 'error') {
        Promise.resolve().then(() => cb(new Error('exec mock error')));
        return;
      }

      const { EventEmitter } = require('events');
      const stream = new EventEmitter();
      stream.stderr  = new EventEmitter();
      stream.destroy = jest.fn(() => {
        // Mimic ssh2: destroy causes close with null exit code
        Promise.resolve().then(() => stream.emit('close', null));
      });
      mockLastStream = stream;
      cb(null, stream);

      if (mockSsh.execResult === 'success') {
        Promise.resolve().then(() => {
          stream.emit('data', mockSsh.stdout);
          stream.stderr.emit('data', mockSsh.stderr);
          stream.emit('close', mockSsh.exitCode);
        });
      }
      // 'timeout': never emits close — the timer in ssh-backend fires instead
    }

    end()     {}
    destroy() {}
  }

  return { Client: MockClient };
});

// ---------------------------------------------------------------------------
// Mock: ../config/cosa.config — hermetic, short timeouts for speed
// ---------------------------------------------------------------------------

/** Base config shared by all tests. No host_key_fingerprint = verification disabled. */
const BASE_SSH_CONFIG = {
  host:               '192.168.1.10',
  port:               22,
  user:               'baanbaan',
  key_path:           '/fake/id_ed25519',
  connect_timeout_ms: 500,
  command_timeout_ms: 80,  // short so timeout tests finish quickly
};

const mockGetConfig = jest.fn();

jest.mock('../config/cosa.config', () => ({
  getConfig: (...a) => mockGetConfig(...a),
}));

// ---------------------------------------------------------------------------
// Mock: fs — intercept private-key read without touching the real filesystem
// ---------------------------------------------------------------------------

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  readFileSync: jest.fn((p, ...rest) => {
    if (p === '/fake/id_ed25519') return Buffer.from('FAKE_PRIVATE_KEY');
    return jest.requireActual('fs').readFileSync(p, ...rest);
  }),
}));

// ── logger ───────────────────────────────────────────────────────────────────
jest.mock('../src/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Module under test (required AFTER mocks are registered)
// ---------------------------------------------------------------------------

const { exec, isConnected, init, disconnect, backoffMs } = require('../src/ssh-backend');

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockSsh.connectResult      = 'success';
  mockSsh.execResult         = 'success';
  mockSsh.stdout             = '';
  mockSsh.stderr             = '';
  mockSsh.exitCode           = 0;
  mockSsh.lastClient         = null;
  mockSsh.lastConnectOptions = null;
  mockSsh.mockHostKey        = null;
  mockLastStream             = null;
  mockGetConfig.mockReturnValue({ appliance: { ssh: { ...BASE_SSH_CONFIG } } });
  disconnect();
});

afterEach(() => {
  disconnect();
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// AC3 — backoffMs() pure function
// ---------------------------------------------------------------------------

describe('backoffMs()', () => {
  it('returns 1000ms for attempt 0', () => expect(backoffMs(0)).toBe(1000));
  it('returns 2000ms for attempt 1', () => expect(backoffMs(1)).toBe(2000));
  it('returns 4000ms for attempt 2', () => expect(backoffMs(2)).toBe(4000));
  it('returns 8000ms for attempt 3', () => expect(backoffMs(3)).toBe(8000));
  it('returns 16000ms for attempt 4', () => expect(backoffMs(4)).toBe(16000));

  it('caps at 30000ms for attempt 5 and beyond', () => {
    expect(backoffMs(5)).toBe(30000);
    expect(backoffMs(6)).toBe(30000);
    expect(backoffMs(100)).toBe(30000);
  });
});

// ---------------------------------------------------------------------------
// AC2 — isConnected()
// ---------------------------------------------------------------------------

describe('isConnected()', () => {
  it('returns false before init()', () => {
    expect(isConnected()).toBe(false);
  });

  it('returns true after a successful init()', async () => {
    await init();
    expect(isConnected()).toBe(true);
  });

  it('returns false after disconnect()', async () => {
    await init();
    disconnect();
    expect(isConnected()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC1 — exec() — basic contract
// ---------------------------------------------------------------------------

describe('exec()', () => {
  it('rejects when not connected', async () => {
    await expect(exec('echo hello')).rejects.toThrow('SSH not connected');
  });

  it('returns stdout, stderr, and exitCode on success', async () => {
    mockSsh.stdout   = 'hello world\n';
    mockSsh.stderr   = '';
    mockSsh.exitCode = 0;

    await init();
    const result = await exec('echo hello');

    expect(result.stdout).toBe('hello world\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('captures stderr and non-zero exitCode', async () => {
    mockSsh.stdout   = '';
    mockSsh.stderr   = 'command not found\n';
    mockSsh.exitCode = 127;

    await init();
    const result = await exec('notacommand');

    expect(result.exitCode).toBe(127);
    expect(result.stderr).toBe('command not found\n');
  });

  it('returns exitCode 1 when stream closes with null (abrupt close)', async () => {
    mockSsh.exitCode = null;
    await init();
    const result = await exec('something');
    expect(result.exitCode).toBe(1);
  });

  it('rejects when ssh2 exec() itself returns an error', async () => {
    mockSsh.execResult = 'error';
    await init();
    await expect(exec('whoami')).rejects.toThrow('exec mock error');
  });
});

// ---------------------------------------------------------------------------
// AC4 — command timeout
// ---------------------------------------------------------------------------

describe('exec() — command timeout', () => {
  it('rejects with a timeout error when the stream never closes', async () => {
    jest.useFakeTimers();
    mockSsh.execResult = 'timeout';

    const initP = init();
    await jest.runAllTimersAsync();
    await initP;

    const execP = exec('sleep 9999');
    jest.advanceTimersByTime(200); // past the 80ms mock timeout
    await jest.runAllTimersAsync();

    await expect(execP).rejects.toThrow('timed out');
  });

  it('calls stream.destroy() when the timeout fires', async () => {
    jest.useFakeTimers();
    mockSsh.execResult = 'timeout';

    const initP = init();
    await jest.runAllTimersAsync();
    await initP;

    exec('sleep 9999');
    jest.advanceTimersByTime(200);
    await jest.runAllTimersAsync();

    expect(mockLastStream.destroy).toHaveBeenCalled();
  });

  it('resolves normally when the command finishes before the timeout', async () => {
    // execResult 'success' fires close immediately via Promise microtask
    mockSsh.stdout   = 'fast\n';
    mockSsh.exitCode = 0;

    await init();
    const result = await exec('fast-command');
    expect(result.stdout).toBe('fast\n');
  });
});

// ---------------------------------------------------------------------------
// AC5 — connection parameters from appliance.yaml
// ---------------------------------------------------------------------------

describe('AC5 — connection parameters', () => {
  it('reads the private key from key_path in config', async () => {
    const fs = require('fs');
    await init();
    expect(fs.readFileSync).toHaveBeenCalledWith('/fake/id_ed25519');
  });

  it('reaches connected state using config values', async () => {
    await init();
    expect(isConnected()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC7 — startup failure is a warning, not a crash
// ---------------------------------------------------------------------------

describe('AC7 — startup failure handling', () => {
  it('does not throw when the initial connection fails', async () => {
    mockSsh.connectResult = 'error';
    await expect(init()).resolves.toBeUndefined();
  });

  it('logs console.warn when the initial connection fails', async () => {
    mockSsh.connectResult = 'error';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await init();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/SSH.*failed/i));
    warnSpy.mockRestore();
  });

  it('leaves isConnected() false after a failed init()', async () => {
    mockSsh.connectResult = 'error';
    await init();
    expect(isConnected()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC3 — reconnect with exponential backoff
// ---------------------------------------------------------------------------

describe('AC3 — reconnect on drop', () => {
  it('reconnects automatically after an unexpected connection close', async () => {
    jest.useFakeTimers();

    // Initial connect
    const initP = init();
    await jest.runAllTimersAsync();
    await initP;
    expect(isConnected()).toBe(true);

    // Simulate connection drop
    mockSsh.lastClient.emit('close');
    expect(isConnected()).toBe(false);

    // Advance through the first backoff window (1000ms) and flush reconnect
    jest.advanceTimersByTime(1100);
    await jest.runAllTimersAsync();

    expect(isConnected()).toBe(true);
  });

  it('does not schedule more than one concurrent reconnect timer', async () => {
    jest.useFakeTimers();

    const initP = init();
    await jest.runAllTimersAsync();
    await initP;

    // After the first close, _connected becomes false.
    // Subsequent close events must NOT schedule additional timers.
    const setSpy = jest.spyOn(global, 'setTimeout');
    const before = setSpy.mock.calls.length;

    mockSsh.lastClient.emit('close'); // fires scheduleReconnect(), sets timer
    mockSsh.lastClient.emit('close'); // _connected already false → no-op
    mockSsh.lastClient.emit('close'); // _connected already false → no-op

    const newTimers = setSpy.mock.calls.length - before;
    expect(newTimers).toBe(1);

    setSpy.mockRestore();
  });

  it('uses exponential backoff: second attempt waits longer than first', async () => {
    jest.useFakeTimers();
    mockSsh.connectResult = 'error'; // make reconnects fail so we can observe timing

    // Suppress expected warnings
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    // Trigger reconnect chain
    const initP = init();
    await jest.runAllTimersAsync(); // fires initial error → scheduleReconnect (1000ms)
    await initP;

    const delays = [];
    const origSetTimeout = global.setTimeout;
    jest.spyOn(global, 'setTimeout').mockImplementation((fn, delay) => {
      delays.push(delay);
      return origSetTimeout(fn, delay);
    });

    // Run two backoff cycles
    jest.advanceTimersByTime(1100); // attempt 1 (1000ms)
    await jest.runAllTimersAsync();
    jest.advanceTimersByTime(2200); // attempt 2 (2000ms)
    await jest.runAllTimersAsync();

    expect(delays.length).toBeGreaterThanOrEqual(2);
    expect(delays[1]).toBeGreaterThan(delays[0]);

    jest.restoreAllMocks();
  });
});
