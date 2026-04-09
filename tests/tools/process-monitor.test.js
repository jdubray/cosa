'use strict';

/**
 * Unit tests for src/tools/process-monitor.js
 *
 * Acceptance Criteria covered:
 *   AC1 — executes ps aux via SSH, parses user/pid/cpu/mem/command
 *   AC2 — compares each process against expectedProcesses from config
 *   AC3 — returns processes array with expected and suspicious flags per process
 *   AC4 — returns unknownProcesses array and listeningPorts array
 *   AC5 — unknown process → severity 'medium'
 *   AC6 — unknown process listening on a port → severity 'high'
 *   AC7 — unknown binary executing as root → severity 'critical'
 *   AC8 — risk level is 'read'
 */

// ---------------------------------------------------------------------------
// Mocks — declared before any require() so Jest hoisting works
// ---------------------------------------------------------------------------

const mockIsConnected = jest.fn();
const mockExec        = jest.fn();
const mockGetConfig   = jest.fn();

jest.mock('../../src/ssh-backend', () => ({
  isConnected: (...a) => mockIsConnected(...a),
  exec:        (...a) => mockExec(...a),
}));

jest.mock('../../config/cosa.config', () => ({
  getConfig: (...a) => mockGetConfig(...a),
}));

jest.mock('../../src/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

const { handler, riskLevel, name } = require('../../src/tools/process-monitor');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Base config — known processes: node, sshd, systemd.
 * Known ports: 22, 3000.
 */
const BASE_CONFIG = {
  appliance: {
    monitoring: {
      expected_processes: ['node', 'sshd', 'systemd'],
      known_ports: [22, 3000],
    },
  },
};

/**
 * Build a `ps aux --no-headers` line.
 * Columns: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
 */
function psLine(user, pid, cpu, mem, command) {
  return `${user} ${pid} ${cpu} ${mem} 12345 6789 ? Ss 10:00 0:00 ${command}`;
}

/** All-expected ps output — node + sshd + systemd. */
const PS_ALL_KNOWN =
  psLine('weather', 101, '0.5', '1.2', 'node /app/server.js') + '\n' +
  psLine('root',    102, '0.0', '0.1', '/usr/sbin/sshd -D') + '\n' +
  psLine('root',    1,   '0.0', '0.3', '/sbin/systemd --user');

/** ps output containing an unexpected non-root process. */
const PS_WITH_UNKNOWN_USER =
  PS_ALL_KNOWN + '\n' +
  psLine('weather', 999, '2.1', '3.0', '/tmp/miner --pool pool.example.com');

/** ps output where the unexpected process runs as root. */
const PS_WITH_ROOT_UNKNOWN =
  PS_ALL_KNOWN + '\n' +
  psLine('root', 888, '0.5', '0.8', '/usr/local/bin/backdoor');

/** `ss -tlnp` output for only known ports. */
const SS_KNOWN_ONLY =
  'LISTEN 0 128 0.0.0.0:22    0.0.0.0:* users:(("sshd",pid=102,fd=3))\n' +
  'LISTEN 0 128 0.0.0.0:3000  0.0.0.0:*\n';

/** `ss -tlnp` output that includes an unexpected port 4444. */
const SS_WITH_UNKNOWN_PORT =
  SS_KNOWN_ONLY +
  'LISTEN 0 128 0.0.0.0:4444  0.0.0.0:*\n';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reset and configure the mockExec queue for a handler() call.
 * The handler always makes exactly two exec calls: ps aux then ss/netstat.
 *
 * @param {string}  psStdout   - stdout for the ps aux call
 * @param {string}  ssStdout   - stdout for the ss/netstat call
 * @param {number}  psExitCode - exit code for ps (default 0)
 */
function setupExec(psStdout, ssStdout, psExitCode = 0) {
  mockExec.mockReset();
  mockExec
    .mockResolvedValueOnce({ stdout: psStdout, stderr: '', exitCode: psExitCode })
    .mockResolvedValueOnce({ stdout: ssStdout, stderr: '', exitCode: 0 });
}

// ---------------------------------------------------------------------------
// Lifecycle helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockGetConfig.mockReturnValue(BASE_CONFIG);
  mockIsConnected.mockReturnValue(true);
  setupExec(PS_ALL_KNOWN, SS_KNOWN_ONLY);
});

// ---------------------------------------------------------------------------
// AC8 — module metadata
// ---------------------------------------------------------------------------

describe('AC8 — module metadata', () => {
  it('exports name = process_monitor', () => {
    expect(name).toBe('process_monitor');
  });

  it('exports riskLevel = read', () => {
    expect(riskLevel).toBe('read');
  });
});

// ---------------------------------------------------------------------------
// AC1 — ps aux via SSH, column parsing
// ---------------------------------------------------------------------------

describe('AC1 — ps aux executed via SSH and parsed', () => {
  it('calls sshBackend.exec with ps aux command', async () => {
    await handler();
    expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('ps aux'));
  });

  it('parsed process has user, pid, cpu, mem, command fields', async () => {
    const result = await handler();
    const proc = result.processes[0];
    expect(proc).toHaveProperty('user');
    expect(proc).toHaveProperty('pid');
    expect(typeof proc.pid).toBe('number');
    expect(proc).toHaveProperty('cpu');
    expect(proc).toHaveProperty('mem');
    expect(proc).toHaveProperty('command');
  });

  it('parses all three known processes', async () => {
    const result = await handler();
    expect(result.total_process_count).toBe(3);
    expect(result.processes).toHaveLength(3);
  });

  it('correctly parses a command that contains spaces', async () => {
    const result = await handler();
    const nodeProc = result.processes.find((p) => p.command.startsWith('node'));
    expect(nodeProc).toBeDefined();
    expect(nodeProc.command).toBe('node /app/server.js');
  });

  it('throws when SSH is not connected', async () => {
    mockIsConnected.mockReturnValue(false);
    await expect(handler()).rejects.toThrow(/SSH not connected/i);
  });

  it('throws when ps exits non-zero', async () => {
    setupExec('', SS_KNOWN_ONLY, 1);
    // Override stderr for the failing ps call.
    mockExec.mockReset();
    mockExec.mockResolvedValueOnce({ stdout: '', stderr: 'permission denied', exitCode: 1 });
    await expect(handler()).rejects.toThrow(/ps aux failed/i);
  });
});

// ---------------------------------------------------------------------------
// AC2 + AC3 — comparison against expectedProcesses, expected/suspicious flags
// ---------------------------------------------------------------------------

describe('AC2+AC3 — processes compared against expectedProcesses, flags set', () => {
  it('known processes are flagged expected=true, suspicious=false', async () => {
    const result = await handler();
    for (const proc of result.processes) {
      expect(proc.expected).toBe(true);
      expect(proc.suspicious).toBe(false);
    }
  });

  it('unknown process is flagged expected=false, suspicious=true', async () => {
    setupExec(PS_WITH_UNKNOWN_USER, SS_KNOWN_ONLY);
    const result  = await handler();
    const unknown = result.processes.find((p) => p.command.includes('miner'));
    expect(unknown).toBeDefined();
    expect(unknown.expected).toBe(false);
    expect(unknown.suspicious).toBe(true);
  });

  it('matching uses substring containment (case-sensitive) against COMMAND column', async () => {
    // 'node' pattern should NOT match 'NODE /srv/app' (case-sensitive)
    mockGetConfig.mockReturnValue({
      appliance: {
        monitoring: {
          expected_processes: ['node'],
          known_ports: [22, 3000],
        },
      },
    });
    setupExec(psLine('weather', 201, '0.0', '0.0', 'NODE /srv/app'), SS_KNOWN_ONLY);

    const result   = await handler();
    const nodeProc = result.processes.find((p) => p.command.includes('NODE'));
    expect(nodeProc.expected).toBe(false);
  });

  it('all processes appear in the processes array regardless of expectation', async () => {
    setupExec(PS_WITH_UNKNOWN_USER, SS_KNOWN_ONLY);
    const result = await handler();
    expect(result.processes).toHaveLength(4); // 3 known + 1 unknown
  });
});

// ---------------------------------------------------------------------------
// AC4 — unknownProcesses array and listeningPorts array
// ---------------------------------------------------------------------------

describe('AC4 — unknownProcesses and listeningPorts returned', () => {
  it('unknown_processes is empty when all processes are known', async () => {
    const result = await handler();
    expect(result.unknown_processes).toHaveLength(0);
  });

  it('unknown_processes contains the unexpected process entry', async () => {
    setupExec(PS_WITH_UNKNOWN_USER, SS_KNOWN_ONLY);
    const result = await handler();
    expect(result.unknown_processes).toHaveLength(1);
    expect(result.unknown_processes[0].command).toContain('miner');
  });

  it('unknown_processes entry has user, pid, cpu, mem, command, severity', async () => {
    setupExec(PS_WITH_UNKNOWN_USER, SS_KNOWN_ONLY);
    const result = await handler();
    const entry  = result.unknown_processes[0];
    expect(entry).toHaveProperty('user');
    expect(entry).toHaveProperty('pid');
    expect(entry).toHaveProperty('cpu');
    expect(entry).toHaveProperty('mem');
    expect(entry).toHaveProperty('command');
    expect(entry).toHaveProperty('severity');
  });

  it('listening_ports array is returned', async () => {
    const result = await handler();
    expect(Array.isArray(result.listening_ports)).toBe(true);
  });

  it('listening_ports entries have port and known fields', async () => {
    const result = await handler();
    for (const entry of result.listening_ports) {
      expect(entry).toHaveProperty('port');
      expect(entry).toHaveProperty('known');
    }
  });

  it('known ports are marked known=true in listening_ports', async () => {
    const result = await handler();
    const port22 = result.listening_ports.find((p) => p.port === 22);
    expect(port22.known).toBe(true);
  });

  it('unknown_ports array lists ports not in known_ports config', async () => {
    setupExec(PS_ALL_KNOWN, SS_WITH_UNKNOWN_PORT);
    const result = await handler();
    expect(result.unknown_ports).toContain(4444);
  });

  it('unknown_ports is empty when all ports are known', async () => {
    const result = await handler();
    expect(result.unknown_ports).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC5 — unknown non-root process on no unknown port → severity 'medium'
// ---------------------------------------------------------------------------

describe('AC5 — unknown process → severity medium', () => {
  it('unexpected non-root process with only known ports gets severity=medium', async () => {
    setupExec(PS_WITH_UNKNOWN_USER, SS_KNOWN_ONLY);
    const result = await handler();
    expect(result.unknown_processes[0].severity).toBe('medium');
  });
});

// ---------------------------------------------------------------------------
// AC6 — unknown process when unknown ports exist → severity 'high'
// ---------------------------------------------------------------------------

describe('AC6 — unknown process + unknown port → severity high', () => {
  it('gets severity=high when there is an unknown listening port', async () => {
    setupExec(PS_WITH_UNKNOWN_USER, SS_WITH_UNKNOWN_PORT);
    const result = await handler();
    expect(result.unknown_processes[0].severity).toBe('high');
  });

  it('known processes are NOT escalated even when unknown ports exist', async () => {
    // An unknown port is open but all processes are known → no unknownProcesses
    setupExec(PS_ALL_KNOWN, SS_WITH_UNKNOWN_PORT);
    const result = await handler();
    expect(result.unknown_processes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC7 — unknown root process → severity 'critical'
// ---------------------------------------------------------------------------

describe('AC7 — unknown root binary → severity critical', () => {
  it('gets severity=critical regardless of port state', async () => {
    setupExec(PS_WITH_ROOT_UNKNOWN, SS_KNOWN_ONLY);
    const result = await handler();
    const rootUnknown = result.unknown_processes.find((p) =>
      p.command.includes('backdoor')
    );
    expect(rootUnknown).toBeDefined();
    expect(rootUnknown.severity).toBe('critical');
  });

  it('root takes precedence over unknown port (critical wins over high)', async () => {
    setupExec(PS_WITH_ROOT_UNKNOWN, SS_WITH_UNKNOWN_PORT);
    const result = await handler();
    const rootUnknown = result.unknown_processes.find((p) =>
      p.command.includes('backdoor')
    );
    expect(rootUnknown).toBeDefined();
    expect(rootUnknown.severity).toBe('critical');
  });

  it('known root processes (sshd, systemd) are NOT flagged critical', async () => {
    const result = await handler();
    const sshdProc = result.processes.find((p) => p.command.includes('sshd'));
    expect(sshdProc.suspicious).toBe(false);
    expect(sshdProc.expected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge cases — empty config, empty output
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  it('handles empty ps output gracefully', async () => {
    setupExec('', SS_KNOWN_ONLY);
    const result = await handler();
    expect(result.processes).toHaveLength(0);
    expect(result.unknown_processes).toHaveLength(0);
  });

  it('handles empty ss output gracefully (no ports)', async () => {
    setupExec(PS_ALL_KNOWN, '');
    const result = await handler();
    expect(result.listening_ports).toHaveLength(0);
    expect(result.unknown_ports).toHaveLength(0);
  });

  it('flags all processes as unknown when expected_processes is empty', async () => {
    mockGetConfig.mockReturnValue({
      appliance: {
        monitoring: {
          expected_processes: [],
          known_ports: [22, 3000],
        },
      },
    });
    setupExec(PS_ALL_KNOWN, SS_KNOWN_ONLY);
    const result = await handler();
    expect(result.unknown_processes).toHaveLength(3);
  });

  it('result always contains summary, checked_at, and total_process_count', async () => {
    const result = await handler();
    expect(result).toHaveProperty('summary');
    expect(typeof result.summary).toBe('string');
    expect(result).toHaveProperty('checked_at');
    expect(result).toHaveProperty('total_process_count');
    expect(result.total_process_count).toBe(3);
  });

  it('summary indicates clean when no unknowns found', async () => {
    const result = await handler();
    expect(result.summary).toMatch(/all processes match/i);
  });

  it('summary reports counts when unknowns are found', async () => {
    setupExec(PS_WITH_UNKNOWN_USER, SS_KNOWN_ONLY);
    const result = await handler();
    expect(result.summary).toMatch(/1 unknown process/i);
  });
});
