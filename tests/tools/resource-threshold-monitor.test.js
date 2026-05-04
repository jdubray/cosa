'use strict';

/**
 * Unit tests for src/tools/resource-threshold-monitor.js
 *
 * Acceptance Criteria covered:
 *   AC1  — parseTopBatch extracts 5 per-PID samples and 5 aggregate %Cpu(s) lines
 *   AC2  — matchProfile: returns defaults for unmatched; uses last match for bun seed-admin.ts
 *   AC3  — handler: sustained_cpu finding for process at 99.9% ×5 (severity: high)
 *   AC4  — handler: age_over finding for etimes=4123, even with 0% CPU
 *   AC5  — handler: aggregate_cpu finding for [90, 88, 91, 87, 89] aggregates
 *   AC6  — handler: returns { skipped: true } when enabled: false
 *   AC9  — handler: returns findings: [] for a normal-load scenario
 *   AC10 — parseMemInfo extracts MemAvailable in MiB
 *   AC11 — handler: system_memory_low when all samples below mib_floor
 *   AC12 — handler: no system_memory_low when samples above mib_floor
 *   AC13 — handler: rss_over_sustained for [800,810,805,820,815] MB > 600 threshold
 *   AC14 — handler: no rss_over_sustained for [800,100,100,100,100] (single spike)
 *   AC15 — handler: singleton_orphan for the older of two PIDs matching singleton pattern
 *   AC16 — handler: no singleton_orphan when pattern has singleton: false (or omitted)
 *   AC17 — handler: no singleton_orphan for exactly one PID matching singleton pattern
 *   AC18 — handler: /proc/meminfo failure → warn logged, system_memory check skipped,
 *           other findings unaffected
 */

// ---------------------------------------------------------------------------
// Mocks — declared before any require() so Jest hoisting works
// ---------------------------------------------------------------------------

const mockExec      = jest.fn();
const mockGetConfig = jest.fn();

jest.mock('../../src/ssh-backend', () => ({
  exec: (...a) => mockExec(...a),
}));

jest.mock('../../config/cosa.config', () => ({
  getConfig: (...a) => mockGetConfig(...a),
}));

const mockWarn = jest.fn();
jest.mock('../../src/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info:  jest.fn(),
    warn:  (...a) => mockWarn(...a),
    error: jest.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

const rtm = require('../../src/tools/resource-threshold-monitor');
const {
  handler,
  riskLevel,
  name,
  parseTopBatch,
  parseMemInfo,
  parsePsEtimes,
  matchProfile,
  countOver,
  countUnder,
} = rtm;

// ---------------------------------------------------------------------------
// Config fixtures
// ---------------------------------------------------------------------------

/**
 * Base config matching the spec §4 + §12.4.
 * Patterns are ordered most-generic → most-specific (last-match-wins).
 */
const BASE_CFG = {
  appliance: {
    tools: {
      resource_threshold_monitor: {
        enabled: true,
        aggregate_cpu:  { pct: 85,  samples_required: 4, severity: 'high' },
        system_memory:  { mib_floor: 500, samples_required: 4, severity: 'high' },
        defaults: {
          cpu_pct_spike:     99,
          cpu_pct_sustained: 80,
          samples_required:  4,
          rss_mb:            1024,
        },
        patterns: [
          {
            match:             'bun run src/server.ts',
            cpu_pct_spike:     99,
            cpu_pct_sustained: 70,
            rss_mb:            600,
            singleton:         true,
            severity:          'high',
          },
          {
            match:             'bun',
            cpu_pct_spike:     99,
            cpu_pct_sustained: 70,
            rss_mb:            600,
          },
          {
            match:             'bun seed-admin.ts',
            cpu_pct_spike:     99,
            cpu_pct_sustained: 50,
            max_age_seconds:   30,
            rss_mb:            200,
            severity:          'high',
          },
          {
            match:             'chromium',
            cpu_pct_spike:     99,
            cpu_pct_sustained: 90,
            rss_mb:            800,
          },
          {
            match:             'gunicorn',
            cpu_pct_spike:     99,
            cpu_pct_sustained: 60,
            rss_mb:            300,
          },
        ],
        dedup_window_minutes: 30,
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/**
 * Build one top -b iteration block.
 *
 * @param {{ cpuUs?: number, cpuSy?: number, cpuNi?: number, procs?: Array }} opts
 * @returns {string}
 */
function makeTopIteration({
  cpuUs = 5.2,
  cpuSy = 1.3,
  cpuNi = 0.0,
  procs = [],
} = {}) {
  const cpuId = Math.max(0, 100 - cpuUs - cpuSy - cpuNi);
  const lines = [
    'top - 14:23:45 up 1 day,  2:05,  0 users,  load average: 0.50, 0.45, 0.40',
    'Tasks:  47 total,   1 running,  46 sleeping,   0 stopped,   0 zombie',
    `%Cpu(s): ${cpuUs.toFixed(1)} us, ${cpuSy.toFixed(1)} sy, ${cpuNi.toFixed(1)} ni,${cpuId.toFixed(1)} id,  0.5 wa,  0.0 hi,  0.0 si,  0.0 st`,
    'MiB Mem :   3906.2 total,    876.4 free,    512.3 used,   2517.5 buff/cache',
    'MiB Swap:   2048.0 total,   2048.0 free,      0.0 used.   3215.8 avail Mem ',
    '',
    '  PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND',
  ];
  for (const { pid, cpu = 0.0, rssMb = 50, command, user = 'baanbaan' } of procs) {
    const rssKib = Math.round(rssMb * 1024);
    lines.push(
      `${String(pid).padStart(5)} ${user.padEnd(9)} 20   0  512000 ${String(rssKib).padStart(6)}  14000 S ${cpu.toFixed(1).padStart(5)}  2.4   2:34.56 ${command}`
    );
  }
  return lines.join('\n');
}

/**
 * Repeat the same iteration block N times (simulating -bn5).
 */
function makeTopBatch(iterations) {
  return iterations.join('\n');
}

/**
 * Build a ps -o pid,etimes,command --no-headers output line.
 */
function makePsEtimesLine(pid, etimes, command) {
  return `${pid} ${etimes} ${command}`;
}

// ---------------------------------------------------------------------------
// Top fixture — normal load (AC9, AC12, AC17)
// Low CPU, low RSS, one known process; all samples well within thresholds.
// ---------------------------------------------------------------------------

const NORMAL_PROC = { pid: 166741, cpu: 1.5, rssMb: 96, command: 'bun run src/server.ts' };

const TOP_NORMAL = makeTopBatch([
  makeTopIteration({ cpuUs: 5.2, cpuSy: 1.3, procs: [NORMAL_PROC] }),
  makeTopIteration({ cpuUs: 4.8, cpuSy: 1.1, procs: [NORMAL_PROC] }),
  makeTopIteration({ cpuUs: 5.5, cpuSy: 1.4, procs: [NORMAL_PROC] }),
  makeTopIteration({ cpuUs: 4.9, cpuSy: 1.2, procs: [NORMAL_PROC] }),
  makeTopIteration({ cpuUs: 5.1, cpuSy: 1.3, procs: [NORMAL_PROC] }),
]);

// ---------------------------------------------------------------------------
// Top fixture — AC1: five distinct iterations, two PIDs
// ---------------------------------------------------------------------------

const AC1_PROC_A = { pid: 166741, cpu: 1.5, rssMb: 96,  command: 'bun run src/server.ts' };
const AC1_PROC_B = { pid: 102,    cpu: 0.0, rssMb: 2,   command: 'sshd -D' };

const TOP_AC1 = makeTopBatch([
  makeTopIteration({ cpuUs: 5.2, cpuSy: 1.3, procs: [AC1_PROC_A, AC1_PROC_B] }),
  makeTopIteration({ cpuUs: 4.8, cpuSy: 1.1, procs: [AC1_PROC_A, AC1_PROC_B] }),
  makeTopIteration({ cpuUs: 5.5, cpuSy: 1.4, procs: [AC1_PROC_A, AC1_PROC_B] }),
  makeTopIteration({ cpuUs: 4.9, cpuSy: 1.2, procs: [AC1_PROC_A, AC1_PROC_B] }),
  makeTopIteration({ cpuUs: 5.1, cpuSy: 1.3, procs: [AC1_PROC_A, AC1_PROC_B] }),
]);

// ---------------------------------------------------------------------------
// Top fixture — AC3: bun seed-admin.ts at 99.9% CPU × 5
// cpu_pct_sustained=50, samples_required=4 → 5 of 5 over → sustained_cpu finding
// ---------------------------------------------------------------------------

const SEED_ADMIN_HIGH_CPU = { pid: 68198, cpu: 99.9, rssMb: 50, command: 'bun seed-admin.ts' };

const TOP_SUSTAINED_CPU = makeTopBatch([
  makeTopIteration({ cpuUs: 50.0, cpuSy: 1.0, procs: [SEED_ADMIN_HIGH_CPU] }),
  makeTopIteration({ cpuUs: 49.0, cpuSy: 1.0, procs: [SEED_ADMIN_HIGH_CPU] }),
  makeTopIteration({ cpuUs: 50.5, cpuSy: 1.0, procs: [SEED_ADMIN_HIGH_CPU] }),
  makeTopIteration({ cpuUs: 49.5, cpuSy: 1.0, procs: [SEED_ADMIN_HIGH_CPU] }),
  makeTopIteration({ cpuUs: 50.0, cpuSy: 1.0, procs: [SEED_ADMIN_HIGH_CPU] }),
]);

const PS_SEED_ADMIN = [
  makePsEtimesLine(68198, 120, 'bun seed-admin.ts'),
].join('\n');

// ---------------------------------------------------------------------------
// Top fixture — AC4: bun seed-admin.ts at 0% CPU but etimes=4123
// max_age_seconds=30 → age_over finding even with no CPU violation
// ---------------------------------------------------------------------------

const SEED_ADMIN_LOW_CPU = { pid: 68198, cpu: 0.0, rssMb: 50, command: 'bun seed-admin.ts' };

const TOP_AGE_OVER = makeTopBatch([
  makeTopIteration({ procs: [SEED_ADMIN_LOW_CPU] }),
  makeTopIteration({ procs: [SEED_ADMIN_LOW_CPU] }),
  makeTopIteration({ procs: [SEED_ADMIN_LOW_CPU] }),
  makeTopIteration({ procs: [SEED_ADMIN_LOW_CPU] }),
  makeTopIteration({ procs: [SEED_ADMIN_LOW_CPU] }),
]);

const PS_AGE_4123 = makePsEtimesLine(68198, 4123, 'bun seed-admin.ts');

// ---------------------------------------------------------------------------
// Top fixture — AC5: aggregate CPU [90, 88, 91, 87, 89] — all above 85 threshold
// aggregate_cpu.samples_required=4 → 5 of 5 over → aggregate_cpu finding
// ---------------------------------------------------------------------------

const TOP_AGG_CPU = makeTopBatch([
  makeTopIteration({ cpuUs: 85.0, cpuSy: 5.0, procs: [NORMAL_PROC] }),
  makeTopIteration({ cpuUs: 83.0, cpuSy: 5.0, procs: [NORMAL_PROC] }),
  makeTopIteration({ cpuUs: 86.0, cpuSy: 5.0, procs: [NORMAL_PROC] }),
  makeTopIteration({ cpuUs: 82.0, cpuSy: 5.0, procs: [NORMAL_PROC] }),
  makeTopIteration({ cpuUs: 84.0, cpuSy: 5.0, procs: [NORMAL_PROC] }),
]);

const PS_NORMAL_PROC = makePsEtimesLine(166741, 15010, 'bun run src/server.ts');

// ---------------------------------------------------------------------------
// Top fixture — AC13: high RSS × 5 samples (gunicorn, rss_mb threshold=300)
// rssMb=820 MB > 300 MB, 5 of 5 samples → rss_over_sustained
// ---------------------------------------------------------------------------

const GUNICORN_HIGH_RSS = { pid: 55001, cpu: 0.5, rssMb: 820, command: 'gunicorn server:app' };

const TOP_HIGH_RSS_SUSTAINED = makeTopBatch([
  makeTopIteration({ procs: [GUNICORN_HIGH_RSS] }),
  makeTopIteration({ procs: [{ ...GUNICORN_HIGH_RSS, rssMb: 810 }] }),
  makeTopIteration({ procs: [{ ...GUNICORN_HIGH_RSS, rssMb: 805 }] }),
  makeTopIteration({ procs: [{ ...GUNICORN_HIGH_RSS, rssMb: 820 }] }),
  makeTopIteration({ procs: [{ ...GUNICORN_HIGH_RSS, rssMb: 815 }] }),
]);

// ---------------------------------------------------------------------------
// Top fixture — AC14: single RSS spike then drop (gunicorn)
// Only 1 of 5 samples over 300 MB → should NOT fire (samples_required=4)
// ---------------------------------------------------------------------------

const TOP_HIGH_RSS_SPIKE = makeTopBatch([
  makeTopIteration({ procs: [{ ...GUNICORN_HIGH_RSS, rssMb: 820 }] }),
  makeTopIteration({ procs: [{ ...GUNICORN_HIGH_RSS, rssMb: 100 }] }),
  makeTopIteration({ procs: [{ ...GUNICORN_HIGH_RSS, rssMb: 100 }] }),
  makeTopIteration({ procs: [{ ...GUNICORN_HIGH_RSS, rssMb: 100 }] }),
  makeTopIteration({ procs: [{ ...GUNICORN_HIGH_RSS, rssMb: 100 }] }),
]);

const PS_GUNICORN = makePsEtimesLine(55001, 340000, 'gunicorn server:app');

// ---------------------------------------------------------------------------
// Top fixture — AC15/AC16/AC17: singleton orphan
// Two PIDs both matching 'bun run src/server.ts' pattern (singleton: true)
// ---------------------------------------------------------------------------

const ACTIVE_BUN  = { pid: 166741, cpu: 1.5, rssMb: 96, command: 'bun run src/server.ts' };
const ORPHAN_BUN  = { pid: 139956, cpu: 0.2, rssMb: 86, command: 'bun run src/server.ts' };

const TOP_SINGLETON = makeTopBatch([
  makeTopIteration({ procs: [ACTIVE_BUN, ORPHAN_BUN] }),
  makeTopIteration({ procs: [ACTIVE_BUN, ORPHAN_BUN] }),
  makeTopIteration({ procs: [ACTIVE_BUN, ORPHAN_BUN] }),
  makeTopIteration({ procs: [ACTIVE_BUN, ORPHAN_BUN] }),
  makeTopIteration({ procs: [ACTIVE_BUN, ORPHAN_BUN] }),
]);

// active_pid=166741 etimes=15010 (younger); orphan_pid=139956 etimes=164100 (older)
const PS_SINGLETON = [
  makePsEtimesLine(166741, 15010,  'bun run src/server.ts'),
  makePsEtimesLine(139956, 164100, 'bun run src/server.ts'),
].join('\n');

// ---------------------------------------------------------------------------
// /proc/meminfo fixtures
// ---------------------------------------------------------------------------

/** Normal: MemAvailable 3200 MiB (3276800 kB) — well above 500 MiB floor */
const MEMINFO_NORMAL = `MemTotal:        4000000 kB
MemFree:          200000 kB
MemAvailable:    3276800 kB
Buffers:          204800 kB
Cached:          2457600 kB
SwapCached:            0 kB
Active:           512000 kB
Inactive:        2048000 kB
SwapTotal:       2097152 kB
SwapFree:        2097152 kB
`;

/** Low: MemAvailable 480 MiB (491520 kB) — below 500 MiB floor */
const MEMINFO_LOW = `MemTotal:        4000000 kB
MemFree:           50000 kB
MemAvailable:     491520 kB
Buffers:          204800 kB
Cached:           200000 kB
SwapTotal:       2097152 kB
SwapFree:        2097152 kB
`;

/** High: MemAvailable 1800 MiB (1843200 kB) — comfortably above 500 MiB floor */
const MEMINFO_HIGH = `MemTotal:        4000000 kB
MemFree:         1000000 kB
MemAvailable:    1843200 kB
Buffers:          204800 kB
Cached:           600000 kB
`;

// ---------------------------------------------------------------------------
// Exec mock helper
// ---------------------------------------------------------------------------

/**
 * Set up mockExec for a standard handler() call (3 SSH calls in order):
 *   1. top -bn5 -d 2
 *   2. ps -o pid,etimes,command --no-headers -p ...
 *   3. cat /proc/meminfo
 *
 * @param {string}   topStdout     stdout for the top call
 * @param {string}   psStdout      stdout for the ps etimes call
 * @param {string}   memStdout     stdout for the meminfo call
 * @param {object}  [overrides]    optional exitCode overrides per call
 */
function setupExec(topStdout, psStdout, memStdout, {
  topExit  = 0,
  psExit   = 0,
  memExit  = 0,
  memThrow = false,
} = {}) {
  mockExec.mockReset();
  mockExec
    .mockResolvedValueOnce({ stdout: topStdout,  stderr: '', exitCode: topExit  })
    .mockResolvedValueOnce({ stdout: psStdout,   stderr: '', exitCode: psExit   });

  if (memThrow) {
    mockExec.mockRejectedValueOnce(new Error('SSH connection lost'));
  } else {
    mockExec.mockResolvedValueOnce({ stdout: memStdout, stderr: '', exitCode: memExit });
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockGetConfig.mockReturnValue(BASE_CFG);
  mockWarn.mockReset();
  setupExec(TOP_NORMAL, PS_NORMAL_PROC, MEMINFO_NORMAL);
});

afterEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Module metadata
// ---------------------------------------------------------------------------

describe('module metadata', () => {
  it('exports name = resource_threshold_monitor', () => {
    expect(name).toBe('resource_threshold_monitor');
  });

  it('exports riskLevel = read', () => {
    expect(riskLevel).toBe('read');
  });
});

// ---------------------------------------------------------------------------
// AC1 — parseTopBatch
// ---------------------------------------------------------------------------

describe('AC1 — parseTopBatch', () => {
  it('returns exactly 5 iteration samples from top -bn5 output', () => {
    const samples = parseTopBatch(TOP_AC1);
    expect(samples).toHaveLength(5);
  });

  it('each sample has an aggregateCpu field', () => {
    const samples = parseTopBatch(TOP_AC1);
    for (const s of samples) {
      expect(typeof s.aggregateCpu).toBe('number');
      expect(s.aggregateCpu).toBeGreaterThanOrEqual(0);
    }
  });

  it('aggregateCpu is sum of us + sy + ni (not including id or wa)', () => {
    // First iteration: cpuUs=5.2, cpuSy=1.3, cpuNi=0.0 → expected 6.5
    const samples = parseTopBatch(TOP_AC1);
    expect(samples[0].aggregateCpu).toBeCloseTo(6.5, 1);
  });

  it('each sample has a processes array with pid, cpu, rssMb, command', () => {
    const samples = parseTopBatch(TOP_AC1);
    expect(samples[0].processes.length).toBeGreaterThanOrEqual(2);

    const proc = samples[0].processes.find(p => p.pid === 166741);
    expect(proc).toBeDefined();
    expect(typeof proc.cpu).toBe('number');
    expect(typeof proc.rssMb).toBe('number');
    expect(typeof proc.command).toBe('string');
    expect(proc.command).toContain('bun run src/server.ts');
  });

  it('parses RES column from kB to MB correctly', () => {
    // NORMAL_PROC has rssMb=96, so rssKib ≈ 98304 in fixture
    const samples = parseTopBatch(TOP_AC1);
    const proc = samples[0].processes.find(p => p.pid === 166741);
    // Allow ±1 MB rounding tolerance
    expect(proc.rssMb).toBeCloseTo(96, 0);
  });

  it('cpu column is a float', () => {
    const samples = parseTopBatch(TOP_AC1);
    const proc = samples[0].processes.find(p => p.pid === 166741);
    expect(proc.cpu).toBeCloseTo(1.5, 1);
  });

  it('both PIDs appear across all 5 samples', () => {
    const samples = parseTopBatch(TOP_AC1);
    for (const s of samples) {
      const pids = s.processes.map(p => p.pid);
      expect(pids).toContain(166741);
      expect(pids).toContain(102);
    }
  });
});

// ---------------------------------------------------------------------------
// AC2 — matchProfile
// ---------------------------------------------------------------------------

describe('AC2 — matchProfile', () => {
  const cfg = BASE_CFG.appliance.tools.resource_threshold_monitor;

  it('returns defaults for an unrecognised command', () => {
    const profile = matchProfile('python3 /usr/local/bin/some-script', cfg);
    expect(profile.cpu_pct_sustained).toBe(cfg.defaults.cpu_pct_sustained);
    expect(profile.rss_mb).toBe(cfg.defaults.rss_mb);
    expect(profile.max_age_seconds).toBeUndefined();
  });

  it('returns the bun profile for "bun run src/server.ts"', () => {
    // Matches both "bun run src/server.ts" (first) and "bun" (second), then
    // "bun run src/server.ts" again if listed later — last match wins.
    // With our ordering, bun seed-admin.ts is last so this should resolve to
    // the bun run src/server.ts entry (listed before generic bun in our config).
    // Important: the bun seed-admin.ts pattern should NOT match this command.
    const profile = matchProfile('bun run src/server.ts', cfg);
    // Must not apply seed-admin thresholds
    expect(profile.max_age_seconds).toBeUndefined();
    // singleton should be set
    expect(profile.singleton).toBe(true);
  });

  it('uses the most-specific pattern for "bun seed-admin.ts" (last-match-wins)', () => {
    // "bun seed-admin.ts" matches both "bun" and "bun seed-admin.ts".
    // "bun seed-admin.ts" appears later in patterns → wins.
    const profile = matchProfile('bun seed-admin.ts', cfg);
    expect(profile.max_age_seconds).toBe(30);
    expect(profile.cpu_pct_sustained).toBe(50);
    expect(profile.severity).toBe('high');
  });

  it('applies gunicorn pattern to gunicorn command', () => {
    const profile = matchProfile('gunicorn server:app', cfg);
    expect(profile.cpu_pct_sustained).toBe(60);
    expect(profile.rss_mb).toBe(300);
  });

  it('uses defaults for a command matching no pattern', () => {
    const profile = matchProfile('cupsd', cfg);
    expect(profile.cpu_pct_sustained).toBe(cfg.defaults.cpu_pct_sustained);
  });
});

// ---------------------------------------------------------------------------
// AC6 — enabled: false → { skipped: true }
// ---------------------------------------------------------------------------

describe('AC6 — skips when enabled: false', () => {
  it('returns { skipped: true } and makes no SSH calls', async () => {
    mockGetConfig.mockReturnValue({
      appliance: {
        tools: { resource_threshold_monitor: { enabled: false } },
      },
    });
    mockExec.mockReset();

    const result = await handler();

    expect(result).toEqual({ skipped: true });
    expect(mockExec).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC9 — normal load → findings: []
// ---------------------------------------------------------------------------

describe('AC9 — normal load scenario', () => {
  it('returns findings: [] when all metrics are within thresholds', async () => {
    setupExec(TOP_NORMAL, PS_NORMAL_PROC, MEMINFO_NORMAL);
    const result = await handler();
    expect(result.findings).toEqual([]);
  });

  it('returns summary indicating all clear', async () => {
    setupExec(TOP_NORMAL, PS_NORMAL_PROC, MEMINFO_NORMAL);
    const result = await handler();
    expect(result.summary).toMatch(/within resource thresholds/i);
  });

  it('reports sampled_processes and samples_taken', async () => {
    setupExec(TOP_NORMAL, PS_NORMAL_PROC, MEMINFO_NORMAL);
    const result = await handler();
    expect(result.sampled_processes).toBeGreaterThanOrEqual(1);
    expect(result.samples_taken).toBe(5);
  });

  it('includes a checked_at ISO timestamp', async () => {
    setupExec(TOP_NORMAL, PS_NORMAL_PROC, MEMINFO_NORMAL);
    const result = await handler();
    expect(() => new Date(result.checked_at)).not.toThrow();
    expect(result.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// AC3 — sustained_cpu finding
// ---------------------------------------------------------------------------

describe('AC3 — sustained_cpu finding', () => {
  beforeEach(() => {
    setupExec(TOP_SUSTAINED_CPU, PS_SEED_ADMIN, MEMINFO_NORMAL);
  });

  it('produces a sustained_cpu finding for bun seed-admin.ts at 99.9% × 5', async () => {
    const result = await handler();
    const f = result.findings.find(x => x.kind === 'sustained_cpu' && x.pid === 68198);
    expect(f).toBeDefined();
  });

  it('sustained_cpu finding has severity: high (from bun seed-admin.ts pattern)', async () => {
    const result = await handler();
    const f = result.findings.find(x => x.kind === 'sustained_cpu' && x.pid === 68198);
    expect(f.severity).toBe('high');
  });

  it('sustained_cpu finding includes the cpu samples array', async () => {
    const result = await handler();
    const f = result.findings.find(x => x.kind === 'sustained_cpu' && x.pid === 68198);
    expect(Array.isArray(f.samples)).toBe(true);
    // All 5 samples should be 99.9
    expect(f.samples.every(s => s >= 99)).toBe(true);
  });

  it('sustained_cpu finding records the threshold that was exceeded', async () => {
    const result = await handler();
    const f = result.findings.find(x => x.kind === 'sustained_cpu' && x.pid === 68198);
    expect(f.threshold).toBe(50); // bun seed-admin.ts pattern: cpu_pct_sustained=50
  });
});

// ---------------------------------------------------------------------------
// AC4 — age_over finding
// ---------------------------------------------------------------------------

describe('AC4 — age_over finding', () => {
  beforeEach(() => {
    setupExec(TOP_AGE_OVER, PS_AGE_4123, MEMINFO_NORMAL);
  });

  it('produces an age_over finding for bun seed-admin.ts at etimes=4123', async () => {
    const result = await handler();
    const f = result.findings.find(x => x.kind === 'age_over' && x.pid === 68198);
    expect(f).toBeDefined();
  });

  it('age_over finding has age_seconds matching ps etimes output', async () => {
    const result = await handler();
    const f = result.findings.find(x => x.kind === 'age_over');
    expect(f.age_seconds).toBe(4123);
  });

  it('age_over finding records the max_age_seconds threshold', async () => {
    const result = await handler();
    const f = result.findings.find(x => x.kind === 'age_over');
    expect(f.threshold).toBe(30);
  });

  it('age_over fires even when all CPU samples are 0.0 (no CPU violation)', async () => {
    const result = await handler();
    // No sustained_cpu finding expected
    expect(result.findings.find(x => x.kind === 'sustained_cpu')).toBeUndefined();
    // But age_over is present
    expect(result.findings.find(x => x.kind === 'age_over')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AC5 — aggregate_cpu finding
// ---------------------------------------------------------------------------

describe('AC5 — aggregate_cpu finding', () => {
  beforeEach(() => {
    // TOP_AGG_CPU: us+sy = 90, 88, 91, 87, 89 — all above pct=85, need 4 of 5
    setupExec(TOP_AGG_CPU, PS_NORMAL_PROC, MEMINFO_NORMAL);
  });

  it('produces an aggregate_cpu finding when all 5 aggregates exceed 85', async () => {
    const result = await handler();
    const f = result.findings.find(x => x.kind === 'aggregate_cpu');
    expect(f).toBeDefined();
  });

  it('aggregate_cpu finding records the samples array', async () => {
    const result = await handler();
    const f = result.findings.find(x => x.kind === 'aggregate_cpu');
    expect(Array.isArray(f.samples)).toBe(true);
    expect(f.samples).toHaveLength(5);
    // All should exceed 85
    expect(f.samples.every(s => s > 85)).toBe(true);
  });

  it('aggregate_cpu finding has threshold 85 and severity high', async () => {
    const result = await handler();
    const f = result.findings.find(x => x.kind === 'aggregate_cpu');
    expect(f.threshold).toBe(85);
    expect(f.severity).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// AC10 — parseMemInfo
// ---------------------------------------------------------------------------

describe('AC10 — parseMemInfo', () => {
  it('extracts MemAvailable in MiB from /proc/meminfo', () => {
    // MEMINFO_NORMAL: MemAvailable = 3276800 kB → 3200 MiB
    const { memAvailableMib } = parseMemInfo(MEMINFO_NORMAL);
    expect(memAvailableMib).toBeCloseTo(3200, 0);
  });

  it('returns memAvailableMib as a number', () => {
    const { memAvailableMib } = parseMemInfo(MEMINFO_NORMAL);
    expect(typeof memAvailableMib).toBe('number');
  });

  it('returns null when MemAvailable line is missing', () => {
    const { memAvailableMib } = parseMemInfo('MemTotal: 4000000 kB\nMemFree: 200000 kB\n');
    expect(memAvailableMib).toBeNull();
  });

  it('correctly converts kB to MiB for the low fixture', () => {
    // MEMINFO_LOW: MemAvailable = 491520 kB → 480 MiB
    const { memAvailableMib } = parseMemInfo(MEMINFO_LOW);
    expect(memAvailableMib).toBeCloseTo(480, 0);
  });
});

// ---------------------------------------------------------------------------
// AC11 — system_memory_low fires when all samples below floor
// ---------------------------------------------------------------------------

describe('AC11 — system_memory_low when samples below mib_floor', () => {
  it('produces a system_memory_low finding when MemAvailable < 500 MiB', async () => {
    // MEMINFO_LOW: MemAvailable = 480 MiB, floor = 500 MiB
    // Replicated to 5 samples → countUnder = 5, samples_required = 4 → fires
    setupExec(TOP_NORMAL, PS_NORMAL_PROC, MEMINFO_LOW);
    const result = await handler();
    const f = result.findings.find(x => x.kind === 'system_memory_low');
    expect(f).toBeDefined();
  });

  it('system_memory_low finding includes samples_mib and floor_mib', async () => {
    setupExec(TOP_NORMAL, PS_NORMAL_PROC, MEMINFO_LOW);
    const result = await handler();
    const f = result.findings.find(x => x.kind === 'system_memory_low');
    expect(Array.isArray(f.samples_mib)).toBe(true);
    expect(f.samples_mib).toHaveLength(5);
    expect(f.floor_mib).toBe(500);
    expect(f.severity).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// AC12 — no system_memory_low when samples above floor
// ---------------------------------------------------------------------------

describe('AC12 — no system_memory_low when samples above mib_floor', () => {
  it('does not fire when MemAvailable is 1800 MiB (above 500 MiB floor)', async () => {
    setupExec(TOP_NORMAL, PS_NORMAL_PROC, MEMINFO_HIGH);
    const result = await handler();
    expect(result.findings.find(x => x.kind === 'system_memory_low')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC13 — rss_over_sustained: K-of-N RSS samples over threshold
// ---------------------------------------------------------------------------

describe('AC13 — rss_over_sustained fires when K-of-N RSS samples exceed threshold', () => {
  // gunicorn rss_mb=300; samples [820,810,805,820,815] → all 5 > 300, need 4
  beforeEach(() => {
    setupExec(TOP_HIGH_RSS_SUSTAINED, PS_GUNICORN, MEMINFO_NORMAL);
  });

  it('produces rss_over_sustained finding for gunicorn', async () => {
    const result = await handler();
    const f = result.findings.find(x => x.kind === 'rss_over_sustained' && x.pid === 55001);
    expect(f).toBeDefined();
  });

  it('rss_over_sustained includes rss_samples_mb and threshold', async () => {
    const result = await handler();
    const f = result.findings.find(x => x.kind === 'rss_over_sustained');
    expect(Array.isArray(f.rss_samples_mb)).toBe(true);
    expect(f.rss_samples_mb).toHaveLength(5);
    expect(f.threshold).toBe(300);
  });

  it('rss_over_sustained does not fire an instantaneous-check finding', async () => {
    // The old rss_over kind must not appear
    const result = await handler();
    expect(result.findings.find(x => x.kind === 'rss_over')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC14 — rss_over_sustained: single spike does NOT fire
// ---------------------------------------------------------------------------

describe('AC14 — rss_over_sustained does not fire on a single RSS spike', () => {
  // gunicorn: [820, 100, 100, 100, 100] → only 1 of 5 over 300 MB threshold
  // samples_required=4 (from defaults, gunicorn pattern has no override)
  beforeEach(() => {
    setupExec(TOP_HIGH_RSS_SPIKE, PS_GUNICORN, MEMINFO_NORMAL);
  });

  it('produces no rss_over_sustained finding when only 1 of 5 samples exceeds threshold', async () => {
    const result = await handler();
    expect(result.findings.find(x => x.kind === 'rss_over_sustained')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC15 — singleton_orphan: older of two matching PIDs is tagged
// ---------------------------------------------------------------------------

describe('AC15 — singleton_orphan for older duplicate of singleton pattern', () => {
  beforeEach(() => {
    setupExec(TOP_SINGLETON, PS_SINGLETON, MEMINFO_NORMAL);
  });

  it('produces a singleton_orphan finding', async () => {
    const result = await handler();
    const f = result.findings.find(x => x.kind === 'singleton_orphan');
    expect(f).toBeDefined();
  });

  it('singleton_orphan targets the older PID (larger etimes)', async () => {
    // PID 139956 has etimes=164100 (older); PID 166741 has etimes=15010 (active)
    const result = await handler();
    const f = result.findings.find(x => x.kind === 'singleton_orphan');
    expect(f.pid).toBe(139956);
    expect(f.age_seconds).toBe(164100);
  });

  it('singleton_orphan reports the active_pid correctly', async () => {
    const result = await handler();
    const f = result.findings.find(x => x.kind === 'singleton_orphan');
    expect(f.active_pid).toBe(166741);
    expect(f.active_age_seconds).toBe(15010);
  });

  it('singleton_orphan includes pattern, rss_mb, and severity', async () => {
    const result = await handler();
    const f = result.findings.find(x => x.kind === 'singleton_orphan');
    expect(f.pattern).toBe('bun run src/server.ts');
    expect(typeof f.rss_mb).toBe('number');
    expect(f.severity).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// AC16 — no singleton_orphan when pattern does not have singleton: true
// ---------------------------------------------------------------------------

describe('AC16 — no singleton_orphan when singleton flag is absent/false', () => {
  it('does not fire singleton_orphan when singleton is false on the matching pattern', async () => {
    // Use a config where bun run src/server.ts has singleton: false
    const cfgNoSingleton = JSON.parse(JSON.stringify(BASE_CFG));
    const pat = cfgNoSingleton.appliance.tools.resource_threshold_monitor.patterns
      .find(p => p.match === 'bun run src/server.ts');
    pat.singleton = false;
    mockGetConfig.mockReturnValue(cfgNoSingleton);

    setupExec(TOP_SINGLETON, PS_SINGLETON, MEMINFO_NORMAL);
    const result = await handler();
    expect(result.findings.find(x => x.kind === 'singleton_orphan')).toBeUndefined();
  });

  it('does not fire singleton_orphan when singleton key is entirely absent from pattern', async () => {
    const cfgNoSingleton = JSON.parse(JSON.stringify(BASE_CFG));
    const pat = cfgNoSingleton.appliance.tools.resource_threshold_monitor.patterns
      .find(p => p.match === 'bun run src/server.ts');
    delete pat.singleton;
    mockGetConfig.mockReturnValue(cfgNoSingleton);

    setupExec(TOP_SINGLETON, PS_SINGLETON, MEMINFO_NORMAL);
    const result = await handler();
    expect(result.findings.find(x => x.kind === 'singleton_orphan')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC17 — no singleton_orphan for exactly one PID matching a singleton pattern
// ---------------------------------------------------------------------------

describe('AC17 — no singleton_orphan for exactly one matching PID', () => {
  it('does not fire when only one PID matches the singleton pattern', async () => {
    // TOP_NORMAL has only one bun run src/server.ts PID (166741)
    setupExec(TOP_NORMAL, PS_NORMAL_PROC, MEMINFO_NORMAL);
    const result = await handler();
    expect(result.findings.find(x => x.kind === 'singleton_orphan')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC18 — /proc/meminfo failure degrades gracefully
// ---------------------------------------------------------------------------

describe('AC18 — /proc/meminfo failure: warn and skip system_memory check', () => {
  it('logs a warning when /proc/meminfo SSH call fails', async () => {
    setupExec(TOP_SUSTAINED_CPU, PS_SEED_ADMIN, '', { memThrow: true });
    await handler();
    expect(mockWarn).toHaveBeenCalledWith(expect.stringMatching(/meminfo|proc/i));
  });

  it('does not produce a system_memory_low finding when meminfo is unavailable', async () => {
    setupExec(TOP_SUSTAINED_CPU, PS_SEED_ADMIN, '', { memThrow: true });
    const result = await handler();
    expect(result.findings.find(x => x.kind === 'system_memory_low')).toBeUndefined();
  });

  it('still produces per-process findings when meminfo fails', async () => {
    // TOP_SUSTAINED_CPU has bun seed-admin.ts at 99.9% × 5
    setupExec(TOP_SUSTAINED_CPU, PS_SEED_ADMIN, '', { memThrow: true });
    const result = await handler();
    expect(result.findings.find(x => x.kind === 'sustained_cpu')).toBeDefined();
  });

  it('also degrades gracefully when meminfo returns non-zero exit code', async () => {
    setupExec(TOP_SUSTAINED_CPU, PS_SEED_ADMIN, '', { memExit: 1 });
    const result = await handler();
    expect(result.findings.find(x => x.kind === 'system_memory_low')).toBeUndefined();
    expect(result.findings.find(x => x.kind === 'sustained_cpu')).toBeDefined();
  });

  it('still returns a valid result shape when meminfo fails', async () => {
    setupExec(TOP_NORMAL, PS_NORMAL_PROC, '', { memThrow: true });
    const result = await handler();
    expect(result).toHaveProperty('findings');
    expect(result).toHaveProperty('sampled_processes');
    expect(result).toHaveProperty('samples_taken');
    expect(result).toHaveProperty('checked_at');
  });
});

// ---------------------------------------------------------------------------
// countOver / countUnder helpers
// ---------------------------------------------------------------------------

describe('countOver helper', () => {
  it('counts elements strictly greater than threshold', () => {
    expect(countOver([99, 50, 80, 99, 99], 80)).toBe(3);
  });

  it('returns 0 when all elements are at or below threshold', () => {
    expect(countOver([80, 80, 79], 80)).toBe(0);
  });

  it('skips null/undefined elements', () => {
    expect(countOver([99, null, null, 99, 99], 80)).toBe(3);
  });
});

describe('countUnder helper', () => {
  it('counts elements strictly less than threshold (floor alert)', () => {
    expect(countUnder([480, 412, 395, 388, 372], 500)).toBe(5);
  });

  it('returns 0 when all elements are at or above threshold', () => {
    expect(countUnder([1800, 1750, 1620, 1900, 1810], 500)).toBe(0);
  });

  it('skips null/undefined elements', () => {
    expect(countUnder([null, 480, null, 412, null], 500)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// parsePsEtimes helper
// ---------------------------------------------------------------------------

describe('parsePsEtimes', () => {
  it('returns a Map of pid → etimes', () => {
    const stdout = [
      '166741 15010 bun run src/server.ts',
      '139956 164100 bun run src/server.ts',
      '68198 4123 bun seed-admin.ts',
    ].join('\n');

    const map = parsePsEtimes(stdout);
    expect(map).toBeInstanceOf(Map);
    expect(map.get(166741)).toBe(15010);
    expect(map.get(139956)).toBe(164100);
    expect(map.get(68198)).toBe(4123);
  });

  it('skips malformed lines', () => {
    const map = parsePsEtimes('not-a-number foo bar\n166741 15010 bun\n');
    expect(map.has(166741)).toBe(true);
    expect(map.size).toBe(1);
  });

  it('returns an empty Map for empty input', () => {
    const map = parsePsEtimes('');
    expect(map.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// top failure — handler throws when top returns non-zero exit
// ---------------------------------------------------------------------------

describe('top command failure', () => {
  it('throws when top -bn5 -d 2 returns non-zero exit code', async () => {
    mockExec.mockReset();
    mockExec.mockResolvedValueOnce({
      stdout: '', stderr: 'TERM variable not set', exitCode: 1,
    });
    await expect(handler()).rejects.toThrow(/top failed/i);
  });
});
