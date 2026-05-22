'use strict';

/**
 * Version-controlled watcher definitions.
 *
 * `watcherRegistry.installSeedWatchers()` runs at boot and inserts any of
 * these whose `id` is not already present in session.db. EXISTING watchers —
 * and their enabled/disabled state and any live edits — are left untouched.
 * So this file repopulates a fresh/rebuilt session.db without clobbering a
 * running system. Edit a *live* watcher via the `watcher_register` tool; edit
 * the *default* here.
 *
 * Each entry: { id, name, description, enabled, code }.
 * `code` is the body registered as the watcher function; it receives the
 * appliance status snapshot as `status` and returns { triggered, message? }.
 */

module.exports = [
  {
    id:          'seed_admin_cpu_spike',
    name:        'Seed-admin script CPU spike',
    description: 'Alert when system CPU load is critically high, consistent with the seed-admin.ts script consuming ~100% CPU as observed on 2026-04-29.',
    enabled:     true,
    code: `function watch(status) {
  const cpuLoad = status?.system?.cpu_1m_avg ?? null;
  if (cpuLoad === null) return { triggered: false };
  // On a 4-core Pi, a 1-minute load average > 3.5 is critical
  if (cpuLoad > 3.5) {
    return { triggered: true, message: "CPU 1-min load is " + cpuLoad.toFixed(2) + " (>3.5 on 4-core Pi). Check for runaway scripts such as seed-admin.ts." };
  }
  return { triggered: false };
}`,
  },
  {
    id:          'pi_undervoltage',
    name:        'Raspberry Pi under-voltage / throttle detected',
    description: 'Throttle/under-voltage flag from the status snapshot. Note: /api/status has no throttle data today; under-voltage is monitored by resource_threshold_monitor via vcgencmd over SSH.',
    enabled:     true,
    code: `function watch(status) {
  const throttled = status?.hardware?.throttled ?? false;
  const underVoltage = status?.hardware?.under_voltage ?? false;
  const throttleFlags = status?.system?.throttle_flags ?? status?.hardware?.throttle_flags ?? null;
  if (throttled || underVoltage) {
    const reasons = [];
    if (underVoltage) reasons.push("under-voltage detected");
    if (throttled) reasons.push("CPU throttled");
    return { triggered: true, message: "Raspberry Pi hardware warning: " + reasons.join(", ") + ". Check power supply." };
  }
  if (throttleFlags !== null && throttleFlags !== 0 && throttleFlags !== "0x0" && throttleFlags !== "0") {
    return { triggered: true, message: "Raspberry Pi throttle flags non-zero: " + throttleFlags + ". Possible under-voltage or thermal event." };
  }
  return { triggered: false };
}`,
  },
  {
    id:          'music_server_outside_morning',
    name:        'Music server active outside morning window',
    description: 'Music server on port 8080 active outside the morning window. Seeded DISABLED: current logic is time-only (fires on the clock regardless of real state) and the snapshot has no port data; placeholder until a real port-8080 check exists.',
    enabled:     false,
    code: `function watch(status) {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const isMorning = utcHour >= 6 && utcHour < 10;
  const uptimeS = status?.system?.uptime_s ?? 0;
  if (!isMorning && uptimeS > 60) {
    return { triggered: true, message: "Music server may still be running outside morning window (06:00-10:00 UTC). Verify port 8080 is not listening." };
  }
  return { triggered: false };
}`,
  },
];
