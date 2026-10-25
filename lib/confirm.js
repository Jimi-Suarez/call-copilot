'use strict';

// Prompt for confirmation before running an API-heavy command.
// Usage: await confirmCost('This makes about 40 API calls (~$0.30).');
// Skip by passing --yes on the command line.
async function confirmCost(message) {
  if (process.argv.includes('--yes')) return;
  process.stdout.write(`\n${message}\nContinue? (y/N): `);
  await new Promise((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.once('data', chunk => {
      process.stdin.pause();
      const ans = chunk.trim().toLowerCase();
      if (ans === 'y' || ans === 'yes') { resolve(); }
      else { console.log('Aborted.'); process.exit(0); }
    });
  });
}

module.exports = { confirmCost };
