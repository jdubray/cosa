'use strict';

const { createLogger } = require('../src/logger');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse every JSON line emitted to stdout during the test. */
function parsedLines() {
  return mockWrite.mock.calls
    .map(([chunk]) => JSON.parse(chunk.trimEnd()));
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let mockWrite;

beforeEach(() => {
  mockWrite = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  // Default to 'debug' so all levels pass unless overridden per test.
  process.env.COSA_LOG_LEVEL = 'debug';
});

afterEach(() => {
  mockWrite.mockRestore();
  delete process.env.COSA_LOG_LEVEL;
});

// ---------------------------------------------------------------------------
// AC1 — Every log line is valid JSON with ts, level, module, and msg fields
// ---------------------------------------------------------------------------

describe('AC1 — log line structure', () => {
  it('emits valid JSON for an info call', () => {
    const log = createLogger('test-module');
    log.info('hello');
    expect(mockWrite).toHaveBeenCalledTimes(1);
    const [chunk] = mockWrite.mock.calls[0];
    expect(() => JSON.parse(chunk)).not.toThrow();
  });

  it('log line contains ts field as ISO 8601', () => {
    const log = createLogger('test-module');
    log.info('hello');
    const [{ ts }] = parsedLines();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('log line contains level field', () => {
    const log = createLogger('test-module');
    log.warn('something');
    const [{ level }] = parsedLines();
    expect(level).toBe('warn');
  });

  it('log line contains module field matching the name passed to createLogger', () => {
    const log = createLogger('ssh-backend');
    log.info('connected');
    const [{ module }] = parsedLines();
    expect(module).toBe('ssh-backend');
  });

  it('log line contains msg field matching the argument', () => {
    const log = createLogger('test-module');
    log.info('the message text');
    const [{ msg }] = parsedLines();
    expect(msg).toBe('the message text');
  });

  it('each line is terminated with a newline', () => {
    const log = createLogger('test-module');
    log.info('hello');
    const [chunk] = mockWrite.mock.calls[0];
    expect(chunk).toMatch(/\n$/);
  });

  it('line contains exactly the four required fields and no extras', () => {
    const log = createLogger('test-module');
    log.info('hello');
    const [line] = parsedLines();
    expect(Object.keys(line).sort()).toEqual(['level', 'module', 'msg', 'ts']);
  });
});

// ---------------------------------------------------------------------------
// AC2 — Log levels are debug, info, warn, error
// ---------------------------------------------------------------------------

describe('AC2 — log level methods', () => {
  it('debug() emits level: debug', () => {
    createLogger('m').debug('d');
    expect(parsedLines()[0].level).toBe('debug');
  });

  it('info() emits level: info', () => {
    createLogger('m').info('i');
    expect(parsedLines()[0].level).toBe('info');
  });

  it('warn() emits level: warn', () => {
    createLogger('m').warn('w');
    expect(parsedLines()[0].level).toBe('warn');
  });

  it('error() emits level: error', () => {
    createLogger('m').error('e');
    expect(parsedLines()[0].level).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// AC3 — Log level is configured via COSA_LOG_LEVEL
// ---------------------------------------------------------------------------

describe('AC3 — COSA_LOG_LEVEL filtering', () => {
  it('level=info: suppresses debug, passes info', () => {
    process.env.COSA_LOG_LEVEL = 'info';
    const log = createLogger('m');
    log.debug('suppressed');
    log.info('visible');
    const lines = parsedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('info');
  });

  it('level=warn: suppresses debug and info, passes warn and error', () => {
    process.env.COSA_LOG_LEVEL = 'warn';
    const log = createLogger('m');
    log.debug('no');
    log.info('no');
    log.warn('yes');
    log.error('yes');
    const levels = parsedLines().map(l => l.level);
    expect(levels).toEqual(['warn', 'error']);
  });

  it('level=error: only passes error', () => {
    process.env.COSA_LOG_LEVEL = 'error';
    const log = createLogger('m');
    log.debug('no');
    log.info('no');
    log.warn('no');
    log.error('yes');
    const lines = parsedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('error');
  });

  it('level=debug: passes all four levels', () => {
    process.env.COSA_LOG_LEVEL = 'debug';
    const log = createLogger('m');
    log.debug('a');
    log.info('b');
    log.warn('c');
    log.error('d');
    expect(parsedLines()).toHaveLength(4);
  });

  it('unknown level falls back to info', () => {
    process.env.COSA_LOG_LEVEL = 'verbose';
    const log = createLogger('m');
    log.debug('no');
    log.info('yes');
    expect(parsedLines()).toHaveLength(1);
  });

  it('missing COSA_LOG_LEVEL defaults to info', () => {
    delete process.env.COSA_LOG_LEVEL;
    const log = createLogger('m');
    log.debug('no');
    log.info('yes');
    expect(parsedLines()).toHaveLength(1);
  });

  it('COSA_LOG_LEVEL is case-insensitive', () => {
    process.env.COSA_LOG_LEVEL = 'WARN';
    const log = createLogger('m');
    log.info('no');
    log.warn('yes');
    const lines = parsedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('warn');
  });

  it('level check is re-evaluated on each call (runtime change)', () => {
    process.env.COSA_LOG_LEVEL = 'error';
    const log = createLogger('m');
    log.info('suppressed');
    expect(parsedLines()).toHaveLength(0);

    process.env.COSA_LOG_LEVEL = 'debug';
    log.info('now visible');
    expect(parsedLines()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AC4 — All loggers include their module name
// ---------------------------------------------------------------------------

describe('AC4 — module name binding', () => {
  it('two loggers with different names emit different module fields', () => {
    const logA = createLogger('module-a');
    const logB = createLogger('module-b');
    logA.info('from a');
    logB.info('from b');
    const [lineA, lineB] = parsedLines();
    expect(lineA.module).toBe('module-a');
    expect(lineB.module).toBe('module-b');
  });

  it('module name is included regardless of log level', () => {
    const log = createLogger('cron-scheduler');
    log.error('boom');
    expect(parsedLines()[0].module).toBe('cron-scheduler');
  });
});

// ---------------------------------------------------------------------------
// AC5 — Output is structured JSON (no plaintext lines)
// ---------------------------------------------------------------------------

describe('AC5 — all output is structured JSON', () => {
  it('every stdout write is parseable as JSON', () => {
    const log = createLogger('m');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    for (const [chunk] of mockWrite.mock.calls) {
      expect(() => JSON.parse(chunk.trimEnd())).not.toThrow();
    }
  });

  it('writes to stdout (not stderr)', () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    createLogger('m').error('err');
    expect(stderrSpy).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
  });
});
