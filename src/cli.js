'use strict';

const readline = require('readline');
const { runSession }   = require('./orchestrator');
const { createLogger } = require('./logger');

const log = createLogger('cli');

// ---------------------------------------------------------------------------
// CLI REPL
// ---------------------------------------------------------------------------

/**
 * Start the interactive COSA CLI.
 *
 * Each non-empty line of stdin is dispatched as a `cli`-type session via the
 * orchestrator.  The agent's response is printed to stdout.  Type 'exit' or
 * 'quit', or press Ctrl+C, to terminate.
 *
 * Story 18 — acceptance criteria:
 *   AC1  Starts successfully when invoked with `node src/main.js --cli`.
 *   AC2  Each input line becomes the `message` of a new orchestrator session
 *        with trigger `{ type: 'cli', source: 'cli' }`.
 *   AC3  The session response is printed to stdout.
 *   AC4  'exit' / 'quit' cause a clean process exit.
 *   AC5  Ctrl+C (SIGINT) causes a clean process exit.
 *   AC6  Empty lines are ignored (no session is started).
 */
function startCli() {
  const rl = readline.createInterface({
    input:    process.stdin,
    output:   process.stdout,
    prompt:   'cosa> ',
    terminal: process.stdin.isTTY,
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const trimmed = line.trim();

    // AC6: Ignore blank lines.
    if (!trimmed) {
      rl.prompt();
      return;
    }

    // AC4: Exit commands.
    if (trimmed === 'exit' || trimmed === 'quit') {
      rl.close();
      return;
    }

    // Pause input while session is running so keystrokes don't interleave.
    rl.pause();

    try {
      // AC2: Dispatch to orchestrator.
      const { response } = await runSession({
        type:    'cli',
        source:  'cli',
        message: trimmed,
      });

      // AC3: Print response.
      process.stdout.write(`${response}\n`);
    } catch (err) {
      process.stderr.write(`Error: ${err.message}\n`);
      log.error(`CLI session error: ${err.message}`);
    }

    rl.resume();
    rl.prompt();
  });

  // AC4/AC5: Exit cleanly when readline closes.
  rl.on('close', () => {
    process.exit(0);
  });

  // AC5: Ctrl+C → close the interface → triggers 'close' above.
  rl.on('SIGINT', () => {
    rl.close();
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { startCli };
