/**
 * Runs the offline test suites. The UI suite needs a live server, so it is not
 * part of `npm test` by default:
 *
 *   npm start                # terminal 1
 *   npm run test:ui          # terminal 2
 */
const { spawnSync } = require('child_process');
const path = require('path');

const suites = ['unit.test.js', 'retention.test.js', 'flush.test.js', 'transit.test.js'];
let failed = 0;

for (const suite of suites) {
  process.stdout.write(`\n=== ${suite} ===\n`);
  const r = spawnSync(process.execPath, [path.join(__dirname, suite)], {
    stdio: 'inherit',
    env: { ...process.env },
  });
  if (r.status !== 0) failed++;
}

process.stdout.write(failed ? `\n${failed} suite(s) FAILED\n` : '\nall suites passed\n');
process.exit(failed ? 1 : 0);
