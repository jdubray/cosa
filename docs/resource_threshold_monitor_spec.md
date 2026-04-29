# Resource Threshold Monitor Spec

**Status:** Draft
**Date:** 2026-04-29
**Owner:** cosa
**Scope:** New tool `src/tools/resource-threshold-monitor.js`, new cron entry in `src/cron-scheduler.js`, new config block in `config/appliance.yaml`, tests in `tests/tools/resource-threshold-monitor.test.js` and `tests/cron-scheduler-phase3.test.js`.
**Out of scope:** Any change to `process_monitor` semantics; any BaanBaan source change.

---

## 1. Context

On 2026-04-29 ~02:46Z the operator noticed elevated CPU on the BaanBaan POS health tab and asked COSA to investigate. The manual investigation (`process_monitor` + `ps aux` snapshot) found:

| PID | Command | %CPU | %MEM |
|---|---|---|---|
| 68198 | `bun seed-admin.ts` | 99.9 | ~1.3 |
| 68227 | `bun seed-admin.ts` | 96.8 | ~1.3 |
| 106916/106950/106951 | gunicorn (music server, port 8080) | low | ~2.0 total |

The two `bun seed-admin.ts` processes are runaways — `seed-admin.ts` is a one-shot CLI that should hash an admin password, INSERT into `admin_users`, and exit in seconds. Instead they sat at 96–99% CPU for an extended period.

**The incident was caught by the operator's eyeballs, not by COSA cron.** `process_monitor` reads `ps aux` every cycle and records `cpu`/`mem` per process, but never compares them against thresholds. Worse, because `bun` is on the `monitoring.expected_processes` whitelist (correctly — the BaanBaan service is bun), `bun seed-admin.ts` matches the whitelist via substring containment and is classified as "expected, no alert." A whitelist entry currently doubles as an exemption from any resource scrutiny.

This spec adds a separate tool that decouples the two questions:

1. **Identity** ("is this process allowed to exist here?") — answered by `process_monitor` against `expected_processes`.
2. **Behavior** ("is this process behaving normally?") — answered by the new `resource_threshold_monitor` against per-pattern thresholds, *regardless of whitelist membership*.

## 2. Design principles

1. **Thresholds apply to every process.** Whitelist membership exempts a process from the identity check, never from the behavior check.
2. **Match on full command, not just binary.** `bun` (the long-running BaanBaan service) and `bun seed-admin.ts` (a one-shot CLI) share a binary but have very different expected profiles. Patterns are substring matches against the full COMMAND column, with later patterns overriding earlier ones (most-specific wins).
3. **Sustained, not instantaneous.** Three layered checks:
   - **Spike** — single sample over a hard ceiling (catches 99%-for-one-tick).
   - **Sustained-elevated** — K-of-N samples within one invocation over a softer ceiling (catches the seed-admin runaway directly).
   - **Long-running short-lived commands** — process age exceeds a per-pattern `max_age_seconds`, regardless of CPU. Catches the runaway-by-not-exiting case even when CPU drops.
4. **No state file.** All sampling happens within a single invocation (`top -bn5 -d 2` → 5 samples, 2s apart, ~10s wall). Keeps the tool reproducible, idempotent, and easy to test.
5. **Aggregate ceiling is independent.** A separate alert when total appliance CPU is saturated for K-of-N samples, regardless of which process is responsible. Catches death-by-thousand-cuts and unknown contributors.

## 3. Sampling approach

Use `top -bn5 -d 2` over SSH:

- `-b` batch mode (no curses), `-n5` five iterations, `-d 2` two-second delay → ~10s wall, 5 instantaneous samples per process.
- Per-process columns: `PID %CPU %MEM RSS COMMAND`.
- Aggregate CPU comes from each iteration's `%Cpu(s):` summary line (`us + sy + ni`, ignore `id`/`wa`).
- Process age via a single `ps -o pid,etimes,command --no-headers -p <pids>` after sampling, scoped to PIDs that appeared in any sample. Avoids parsing top's TIME+ field (cumulative, not age).

`top` is in coreutils-equivalent on every Debian/Raspbian image, so no install dependency. If `top` returns non-zero, the tool logs and aborts the cycle (no false alerts on a broken sample).

## 4. Config schema — `config/appliance.yaml`

New section under `tools:`:

```yaml
resource_threshold_monitor:
  enabled: true
  # Aggregate-CPU ceiling. Alert when K-of-N samples report (us+sy+ni) > pct.
  aggregate_cpu:
    pct: 85
    samples_required: 4   # of 5 (top -bn5)
    severity: high
  # Default per-process thresholds (apply to any command not matched below).
  defaults:
    cpu_pct_spike: 99      # single sample over this → spike alert
    cpu_pct_sustained: 80  # K-of-N over this → sustained alert
    samples_required: 4    # K (out of 5)
    rss_mb: 1024
  # Per-pattern overrides. Patterns are substring matches against the full
  # COMMAND column. Later entries override earlier ones if multiple match
  # (most-specific should be last). Any field omitted falls back to defaults.
  patterns:
    - match: "bun"
      cpu_pct_spike: 99
      cpu_pct_sustained: 70    # service should idle low; sustained 70%+ is suspicious
      rss_mb: 600              # observed steady-state ~150-300 MB
    - match: "bun seed-admin.ts"
      cpu_pct_spike: 99
      cpu_pct_sustained: 50
      max_age_seconds: 30      # CLI; should hash + INSERT + exit. >30s = runaway.
      rss_mb: 200
      severity: high
    - match: "chromium"
      cpu_pct_spike: 99
      cpu_pct_sustained: 90    # PDF render bursts are legitimate
      rss_mb: 800
    - match: "gunicorn"
      cpu_pct_spike: 99
      cpu_pct_sustained: 60
      rss_mb: 300
  # Dedup: don't re-alert the same (category, pattern) inside this window.
  dedup_window_minutes: 30
```

### 4.1 Pattern matching rules

- Matching is substring containment, case-sensitive, against the full COMMAND column (same convention as `expected_processes`).
- Multiple patterns can match a single process; the **last** matching `patterns[]` entry wins (most-specific should be ordered last). This lets `bun seed-admin.ts` override the generic `bun` profile.
- A process matching no pattern uses `defaults`.
- `max_age_seconds` is *only* checked when present on a pattern (no default — it doesn't make sense for long-running services).

## 5. Tool — `src/tools/resource-threshold-monitor.js`

### 5.1 Schema

```js
const NAME       = 'resource_threshold_monitor';
const RISK_LEVEL = 'read';
```

Read-only — never mutates appliance state. Always safe to invoke from cron.

### 5.2 Handler skeleton

```js
async function handler() {
  const cfg = getConfig().appliance.tools?.resource_threshold_monitor ?? {};
  if (cfg.enabled === false) return { skipped: true };

  // 1. Sample with top -bn5 -d 2.
  const topResult = await sshBackend.exec('top -bn5 -d 2');
  if (topResult.exitCode !== 0) {
    throw new Error(`top failed (exit ${topResult.exitCode}): ${topResult.stderr}`);
  }
  const samples = parseTopBatch(topResult.stdout);
  // samples = [{ aggregateCpu: 12.3, processes: [{ pid, cpu, rss, command }, ...] }, ... x5]

  // 2. Per-process roll-up across samples.
  const perPid = rollupByPid(samples);
  // perPid = Map<pid, { command, cpuSamples: number[], rssMaxMb, latestRssMb }>

  // 3. Process ages for the PIDs we saw.
  const pids = [...perPid.keys()];
  const ageResult = await sshBackend.exec(`ps -o pid,etimes,command --no-headers -p ${pids.join(',')}`);
  const ageByPid = parsePsEtimes(ageResult.stdout);

  // 4. Evaluate each PID against its matching pattern (or defaults).
  const findings = [];
  for (const [pid, p] of perPid) {
    const profile = matchProfile(p.command, cfg);
    const ageSec  = ageByPid.get(pid);

    if (anySampleOver(p.cpuSamples, profile.cpu_pct_spike)) {
      findings.push({ kind: 'spike', pid, command: p.command, cpu: Math.max(...p.cpuSamples), threshold: profile.cpu_pct_spike, severity: profile.severity ?? 'medium' });
    }
    if (countOver(p.cpuSamples, profile.cpu_pct_sustained) >= profile.samples_required) {
      findings.push({ kind: 'sustained_cpu', pid, command: p.command, samples: p.cpuSamples, threshold: profile.cpu_pct_sustained, severity: profile.severity ?? 'high' });
    }
    if (p.latestRssMb > profile.rss_mb) {
      findings.push({ kind: 'rss_over', pid, command: p.command, rss_mb: p.latestRssMb, threshold: profile.rss_mb, severity: profile.severity ?? 'medium' });
    }
    if (profile.max_age_seconds != null && ageSec > profile.max_age_seconds) {
      findings.push({ kind: 'age_over', pid, command: p.command, age_seconds: ageSec, threshold: profile.max_age_seconds, severity: profile.severity ?? 'high' });
    }
  }

  // 5. Aggregate CPU check.
  const aggSamples = samples.map((s) => s.aggregateCpu);
  if (countOver(aggSamples, cfg.aggregate_cpu.pct) >= cfg.aggregate_cpu.samples_required) {
    findings.push({ kind: 'aggregate_cpu', samples: aggSamples, threshold: cfg.aggregate_cpu.pct, severity: cfg.aggregate_cpu.severity ?? 'high' });
  }

  return {
    summary: findings.length === 0
      ? 'All processes within resource thresholds.'
      : `${findings.length} threshold violation(s); see findings.`,
    findings,
    sampled_processes: perPid.size,
    samples_taken: samples.length,
    checked_at: new Date().toISOString(),
  };
}
```

### 5.3 Profile matching

```js
function matchProfile(command, cfg) {
  let profile = { ...cfg.defaults };
  for (const pat of cfg.patterns ?? []) {
    if (command.includes(pat.match)) {
      profile = { ...profile, ...pat };  // later wins
    }
  }
  return profile;
}
```

## 6. Cron integration — `src/cron-scheduler.js`

Add a new category constant and dedup window:

```js
const RESOURCE_THRESHOLD_CATEGORY = 'resource_threshold_monitor';
const RESOURCE_THRESHOLD_DEDUP_WINDOW_MS = 30 * 60 * 1000;
```

Schedule every 5 min during business hours, aligned with existing health-check cadence. Tighter than `process_monitor` because the runaway window matters — a 30-min cycle would have caught tonight's seed-admin spike at the next cron tick, but still after substantial CPU burn.

```js
schedule('resource_threshold_monitor', '*/5 8-21 * * *', runResourceThresholdTask);
```

`runResourceThresholdTask` invokes the tool, dedups against `findRecentAlert(RESOURCE_THRESHOLD_CATEGORY, severity, sinceIso)` per (category, severity), and emails the operator on each unique finding. One alert email per invocation that reports >0 findings (not one per finding) — group all findings into a single payload to avoid mailbomb on a saturated appliance.

Honors `tools.resource_threshold_monitor.enabled === false` via the existing AC4b guard.

## 7. Alert format

Severity, body sample:

```
COSA SECURITY ALERT — HIGH

Appliance : Hanuman Thai Cafe
Alert Ref : RTM-<epoch_ms>
Issued At : <iso>

─── WHAT HAPPENED ────────────────────────────────────────
2 of 1 process(es) exceeded resource thresholds.

─── FINDINGS ────────────────────────────────────────────
  • PID 68198 [bun seed-admin.ts]  sustained_cpu  samples=[99.9, 99.8, 99.9, 99.7, 99.9]  threshold=50  severity=high
  • PID 68198 [bun seed-admin.ts]  age_over       age=4123s  threshold=30  severity=high

─── AGGREGATE ───────────────────────────────────────────
  CPU samples: [78.2, 81.4, 79.8, 82.1, 80.6]  threshold=85 → OK
  Sampled processes: 47   Samples taken: 5

─── RESPONSE OPTIONS ─────────────────────────────────────
  • Approve kill of listed PIDs
  • Approve disabling threshold for matched pattern (one cycle)
  • Approve adjustment to threshold (reply with new value)
```

Same style as the existing IPS alert. Action codes follow the existing operator-reply pattern.

## 8. Acceptance criteria

1. `parseTopBatch` correctly extracts 5 per-PID samples and 5 aggregate `%Cpu(s)` lines from a recorded `top -bn5 -d 2` fixture.
2. `matchProfile`:
   - Returns `defaults` for an unmatched command.
   - Returns the most-specific match when multiple patterns match (e.g. `bun seed-admin.ts` overrides `bun`).
3. `handler` against a fixture where one PID has `[99.9, 99.9, 99.9, 99.9, 99.9]` returns one `sustained_cpu` finding with `severity: high`.
4. `handler` against a fixture where one `bun seed-admin.ts` PID has `etimes=4123` returns an `age_over` finding even if its CPU samples are all `0.0`.
5. `handler` against a fixture where `%Cpu(s)` aggregates to `[90, 88, 91, 87, 89]` returns one `aggregate_cpu` finding.
6. `handler` returns `{ skipped: true }` when `enabled: false`.
7. Cron task is registered when `enabled` is unset/`true` and skipped (with the existing "Cron skipped (disabled in appliance.yaml)" log line) when explicitly `false`.
8. Dedup: a second invocation within `dedup_window_minutes` finding the same `(kind, pattern, severity)` does not email a second time.
9. Invoking the tool in a normal-load scenario (all CPU samples < threshold, no long-lived CLI) returns `findings: []` and produces no alert.

## 9. Tonight's incident — would this have caught it?

Yes:

- `bun seed-admin.ts` matches the `bun seed-admin.ts` pattern (most-specific override of `bun`).
- `cpu_pct_sustained: 50`, `samples_required: 4` → with samples `[99.9, 99.8, 99.9, 99.7, 99.9]`, 5 over 50 → fires.
- `max_age_seconds: 30` → process age 4123s → fires independently.
- Both findings rolled into one HIGH email at the next 5-min tick.

Counterfactual: had this monitor been live, the operator would have been paged within 5 minutes of the runaway starting, instead of noticing it via the POS health tab hours later.

## 10. Non-goals (deferred)

- **Cross-invocation history.** No state file, no trend analysis, no per-day baselines. Each invocation is self-contained. If we later want "alert on 4 successive invocations over threshold", that lives in a future spec.
- **Auto-kill.** All actions still go through the operator-approval email flow. The tool does not gain `kill` capability.
- **Per-CPU-core breakdown.** Aggregate `%Cpu(s)` only. Per-core saturation is rare on a 4-core Pi and not worth the parsing complexity.
- **Memory swap-in/out rate.** RSS only for now. If we see swap thrash incidents we can add `vmstat` parsing later.
- **Sharing `ps aux` output with `process_monitor`.** Both tools run their own collection. Same trade-off you accepted for `ss -tlnp` between `process_monitor` and `compliance_verify`: independent commands, independent failure modes, simpler reasoning.

## 11. Rollout

Single commit on `main`:

- `config/appliance.yaml` — new `tools.resource_threshold_monitor` block; thresholds informed by current observed steady-state.
- `src/tools/resource-threshold-monitor.js` — new tool.
- `src/cron-scheduler.js` — new task + schedule call + category constant + dedup window.
- `tests/tools/resource-threshold-monitor.test.js` — covers AC1–AC6, AC9 with `top` fixtures.
- `tests/cron-scheduler-phase3.test.js` — covers AC7, AC8.
- `docs/resource_threshold_monitor_spec.md` — this file.

`package.json` / `package-lock.json` ride the next tag bump per the tag-first policy.

After deploy, manually invoke once to confirm baseline `findings: []` against the current process mix (so the initial thresholds aren't too tight). Adjust pattern thresholds if any legitimate steady-state process trips on first run.
