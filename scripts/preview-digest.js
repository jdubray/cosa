#!/usr/bin/env node
'use strict';

/**
 * Preview the next weekly operational digest body WITHOUT sending email or
 * inserting an alert row.  Intended for validating prompt changes against
 * the live alerts ledger before next Monday's cron fire.
 *
 * Run on the cosa server (so it sees the live session.db):
 *   node scripts/preview-digest.js
 *
 * Side-effects:
 *   - Creates one session row in session.db (orchestrator records every
 *     session it runs).  No alert is created.  No email is sent.
 *   - Consumes Anthropic API tokens for the one session.
 *
 * Cron deduplication is NOT touched, so Monday's scheduled digest will
 * still fire as normal.
 */

const { buildWeeklyDigestTrigger } = require('../src/cron-scheduler');
const orchestrator                 = require('../src/orchestrator');

async function main() {
  const trigger = buildWeeklyDigestTrigger();

  process.stderr.write('---------- TRIGGER PROMPT ----------\n');
  process.stderr.write(trigger.message);
  process.stderr.write('\n---------- END TRIGGER -------------\n');
  process.stderr.write('Running session (this can take 30-90 seconds)...\n\n');

  const { session_id: sessionId, response } = await orchestrator.runSession(trigger);

  process.stdout.write('========== PREVIEW DIGEST BODY ==========\n');
  process.stdout.write(response ?? '(empty response)');
  process.stdout.write('\n========== END PREVIEW =================\n');
  process.stderr.write(`\n(session_id=${sessionId})\n`);
}

main().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(`Preview failed: ${err.stack ?? err.message ?? err}\n`);
    process.exit(1);
  },
);
