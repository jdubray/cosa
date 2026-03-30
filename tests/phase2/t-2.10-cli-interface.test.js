'use strict';

/**
 * T-2.10 — CLI Interface
 *
 * `src/cli.js` starts a readline REPL that:
 *   AC1  Prompts with "cosa> "
 *   AC2  Dispatches each line as a cli-type session
 *   AC3  Prints the response to stdout
 *   AC4  'exit' / 'quit' causes process.exit(0)
 *   AC5  Empty lines are ignored (no session started)
 */

// ---------------------------------------------------------------------------
// Boundary mocks
// ---------------------------------------------------------------------------

const mockMessagesCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () =>
  jest.fn(() => ({ messages: { create: (...a) => mockMessagesCreate(...a) } }))
);

let mockStagingConfig;
jest.mock('../../config/cosa.config', () => ({
  getConfig:    () => mockStagingConfig,
  _resetConfig: () => {},
}));

jest.mock('../../src/ssh-backend', () => ({
  isConnected: jest.fn().mockReturnValue(true),
  exec:        jest.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
  init:        jest.fn().mockResolvedValue(undefined),
  disconnect:  jest.fn(),
}));

jest.mock('imapflow', () => ({
  ImapFlow: jest.fn().mockImplementation(() => ({
    connect:         jest.fn().mockResolvedValue(undefined),
    getMailboxLock:  jest.fn().mockResolvedValue({ release: jest.fn() }),
    search:          jest.fn().mockResolvedValue([]),
    fetchOne:        jest.fn(),
    messageFlagsAdd: jest.fn().mockResolvedValue(undefined),
    logout:          jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({
    sendMail: jest.fn(() => Promise.resolve({ messageId: '<sent@test>' })),
  })),
}));

jest.mock('../../src/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

// ---------------------------------------------------------------------------
// Mock readline so we control the REPL without actual stdin.
// ---------------------------------------------------------------------------

const EventEmitter = require('events');

class MockReadlineInterface extends EventEmitter {
  constructor() {
    super();
    this.prompts = [];
    this.closed  = false;
  }
  prompt() {
    this.prompts.push('cosa> ');
  }
  pause()  {}
  resume() {}
  close() {
    this.closed = true;
    this.emit('close');
  }
}

let mockRlInstance;
jest.mock('readline', () => ({
  createInterface: jest.fn(() => {
    mockRlInstance = new MockReadlineInterface();
    return mockRlInstance;
  }),
}));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const {
  makeStagingConfig, makeTempDataDir, claudeToolUse, claudeEndTurn,
} = require('./harness');

let sessionStore;
let skillStore;
let toolRegistry;
let startCli;

// Capture stdout writes.
const stdoutWrites = [];
let processExitCode = null;

beforeAll(() => {
  process.env.NODE_ENV = 'staging';
  mockStagingConfig    = makeStagingConfig(makeTempDataDir());

  sessionStore = require('../../src/session-store');
  sessionStore.runMigrations();

  skillStore = require('../../src/skill-store');
  skillStore.runMigrations();

  toolRegistry = require('../../src/tool-registry');
  const hc = require('../../src/tools/health-check');
  toolRegistry.register(hc.name, hc.schema, hc.handler, hc.riskLevel);

  // Spy on process.stdout.write and process.exit.
  jest.spyOn(process.stdout, 'write').mockImplementation((data) => {
    stdoutWrites.push(String(data));
    return true;
  });
  jest.spyOn(process, 'exit').mockImplementation((code) => {
    processExitCode = code ?? 0;
  });

  ({ startCli } = require('../../src/cli'));
});

afterAll(() => {
  sessionStore.closeDb();
  toolRegistry._reset();
  jest.restoreAllMocks();
  delete process.env.NODE_ENV;
});

beforeEach(() => {
  stdoutWrites.length = 0;
  processExitCode     = null;
  mockRlInstance      = null;
  jest.clearAllMocks();

  // Re-apply the process spies after clearAllMocks.
  jest.spyOn(process.stdout, 'write').mockImplementation((data) => {
    stdoutWrites.push(String(data));
    return true;
  });
  jest.spyOn(process, 'exit').mockImplementation((code) => {
    processExitCode = code ?? 0;
  });
});

// ---------------------------------------------------------------------------
// T-2.10 assertions
// ---------------------------------------------------------------------------

describe('T-2.10 — CLI interface', () => {
  it('calls rl.prompt() on startup', () => {
    startCli();
    expect(mockRlInstance.prompts.length).toBeGreaterThan(0);
    expect(mockRlInstance.prompts[0]).toBe('cosa> ');
  });

  it('dispatches a non-empty line as a cli-type orchestrator session', async () => {
    mockMessagesCreate.mockResolvedValueOnce(claudeEndTurn('Appliance is healthy.'));

    startCli();
    mockRlInstance.emit('line', 'run health check');
    // Wait for the async session to resolve.
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    // Verify session was created with trigger_type=cli.
    const row = sessionStore.getDb()
      .prepare("SELECT trigger_type, trigger_source FROM sessions WHERE trigger_type='cli' ORDER BY id DESC LIMIT 1")
      .get();
    expect(row).toBeDefined();
    expect(row.trigger_type).toBe('cli');
    expect(row.trigger_source).toBe('cli');
  });

  it('prints the session response to stdout', async () => {
    mockMessagesCreate.mockResolvedValueOnce(claudeEndTurn('The appliance is healthy.'));

    startCli();
    mockRlInstance.emit('line', 'health check please');
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    const allOutput = stdoutWrites.join('');
    expect(allOutput).toContain('The appliance is healthy.');
  });

  it('ignores empty lines without starting a session', async () => {
    const callsBefore = mockMessagesCreate.mock.calls.length;

    startCli();
    mockRlInstance.emit('line', '   ');
    await new Promise(resolve => setImmediate(resolve));

    expect(mockMessagesCreate.mock.calls.length).toBe(callsBefore);
  });

  it('calls process.exit(0) when "exit" is entered', async () => {
    startCli();
    mockRlInstance.emit('line', 'exit');
    await new Promise(resolve => setImmediate(resolve));

    expect(processExitCode).toBe(0);
  });

  it('calls process.exit(0) when "quit" is entered', async () => {
    processExitCode = null;
    startCli();
    mockRlInstance.emit('line', 'quit');
    await new Promise(resolve => setImmediate(resolve));

    expect(processExitCode).toBe(0);
  });

  it('calls process.exit(0) on SIGINT (Ctrl+C)', async () => {
    processExitCode = null;
    startCli();
    mockRlInstance.emit('SIGINT');
    await new Promise(resolve => setImmediate(resolve));

    expect(processExitCode).toBe(0);
  });
});
