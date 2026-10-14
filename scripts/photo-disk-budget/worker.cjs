'use strict';
// P2-2B3D2 (#407): child process for cross-process budget races and SIGKILL cases.
// argv: <mode> <json options>. Reports one JSON line per event on stdout.
Object.assign(process.env, { NODE_ENV: 'test', PRODUCT_PHOTO_DISK_STAGING_ENABLED: 'true' });
const { DevelopmentPhotoDiskBudget, PHOTO_DISK_PROFILES } = require('../../apps/api/src/services/developmentPhotoDiskBudget.ts');

const [mode, raw] = process.argv.slice(2);
const options = JSON.parse(raw);
const say = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const hold = () => setInterval(() => undefined, 1000);

if (mode === 'reserve-and-hold') {
  const budget = new DevelopmentPhotoDiskBudget(options.budget);
  // Start together so the exclusive ledger section is genuinely contended.
  while (Date.now() < options.startAt) { /* spin */ }
  try {
    const reservation = budget.reserve(PHOTO_DISK_PROFILES[options.profile], options.label);
    say({ event: 'reserved', id: reservation.id, bytes: reservation.bytes });
  } catch (error) {
    say({ event: 'rejected', code: error.message });
  }
  if (options.exit) process.exit(0);
  hold();
} else if (mode === 'block-inside-ledger') {
  // Pauses inside the exclusive section (via the injected inventory) so the parent can SIGKILL it there.
  const budget = new DevelopmentPhotoDiskBudget({
    ...options.budget,
    inventory: () => { say({ event: 'inside-lock' }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000); return { bytes: 0, inodes: 0, entries: 0 }; },
  });
  budget.reserve(PHOTO_DISK_PROFILES.b1StagedHttp, 'blocked');
} else {
  throw new Error(`unknown mode ${mode}`);
}
