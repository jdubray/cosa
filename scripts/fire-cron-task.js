#!/usr/bin/env node
'use strict';

/**
 * Manually re-fire a single cron task. Useful when the scheduled run was
 * suppressed by an outage (e.g. the 2026-05-18 03:00 backup that died
 * because the in-process SSH was stuck) and you want to recover the missed
 * run without waiting 24 hours.
 *
 * Run on the cosa server:
 *   node scripts/fire-cron-task.js <task_name>
 *
 * Examples:
 *   node scripts/fire-cron-task.js credential_audit
 *   node scripts/fire-cron-task.js backup
 *   node scripts/fire-cron-task.js backup_verify
 *
 * Without an arg, prints the list of known task names and exits 1.
 *
 * Side-effects:
 *   - Initializes the in-process SSH backend (same code path as a real
 *     cron tick). Will warn if SSH connect fails, just like main.js.
 *   - Whatever the task itself does (email, alert row, SSH commands).
 *   - Dedup windows are honored — if the task suppressed itself last run,
 *     it will say so and exit cleanly.
 */

const sshBackend  = require('../src/ssh-backend');
const cron        = require('../src/cron-scheduler');

async function main() {
  const taskName = process.argv[2];

  const runners = cron._taskRunnerMap();
  const knownNames = Object.keys(runners).sort();

  if (!taskName) {
    process.stderr.write('Usage: node scripts/fire-cron-task.js <task_name>\n\n');
    process.stderr.write('Known tasks:\n');
    for (const name of knownNames) process.stderr.write(`  ${name}\n`);
    process.exit(1);
  }

  if (!Object.prototype.hasOwnProperty.call(runners, taskName)) {
    process.stderr.write(`Unknown task: "${taskName}"\n\n`);
    process.stderr.write('Known tasks:\n');
    for (const name of knownNames) process.stderr.write(`  ${name}\n`);
    process.exit(2);
  }

  // Bring up the SSH backend the same way main.js does, so tasks that hit
  // the appliance work. A short settle delay matches what we used in the
  // ad-hoc credential-audit script earlier today.
  await sshBackend.init();
  await new Promise((r) => setTimeout(r, 1500));

  await cron.fireCronTask(taskName);
  process.stderr.write(`fire-cron-task: ${taskName} complete\n`);
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`fire-cron-task: FAILED — ${err.stack || err.message}\n`);
  process.exit(3);
});
