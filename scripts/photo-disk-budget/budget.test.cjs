'use strict';
// P2-2B3D2 (#407): development disk-budget ledger tests. Disposable roots only.
// Run: node --import tsx --test scripts/photo-disk-budget/budget.test.cjs
// Real ENOSPC cases run only when NOCTELLA_DISK_BUDGET_ENOSPC=1 and os.tmpdir() is a small
// dedicated filesystem (the CI step mounts a 64 MiB ext4 loop image and points TMPDIR at it).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
Object.assign(process.env, { NODE_ENV: 'test', PRODUCT_PHOTO_DISK_STAGING_ENABLED: 'true' });
const {
  DevelopmentPhotoDiskBudget, PHOTO_DISK_PROFILES, attemptReservation, measurePhotoInventory, readFilesystemSpace,
} = require('../../apps/api/src/services/developmentPhotoDiskBudget.ts');

const MiB = 1024 * 1024;
const evidence = [];
const sandboxes = [];
const record = (name, data) => evidence.push({ name, ...data });
const worker = path.join(__dirname, 'worker.cjs');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noctella-photo-fence-'));
  const accounted = path.join(root, 'private');
  fs.mkdirSync(accounted, { mode: 0o700 });
  sandboxes.push(root);
  return { root, accounted, budgetRoot: path.join(root, 'budget') };
}
const roomySpace = () => ({ blockBytes: 4096, freeBytes: 1024 * 1024 * MiB, freeInodes: null });
function budgetFor(box, extra = {}) {
  return new DevelopmentPhotoDiskBudget({ budgetRoot: box.budgetRoot, accountedRoots: [box.accounted], budgetBytes: 1024 * MiB, freeSpaceFloorBytes: 0, space: roomySpace, ...extra });
}
const records = (box) => fs.readdirSync(path.join(box.budgetRoot, 'reservations'));

test.after(() => {
  const dest = process.env.NOCTELLA_DISK_BUDGET_EVIDENCE_DIR;
  if (dest) { fs.mkdirSync(dest, { recursive: true }); fs.writeFileSync(path.join(dest, 'budget-test-evidence.json'), JSON.stringify(evidence, null, 2)); }
  // Disposable test sandboxes only (crash-retained locks/records were already asserted and recorded).
  for (const root of sandboxes) fs.rmSync(root, { recursive: true, force: true });
});

test('profiles: the 42 MiB B1 constant and 74 MiB D1 bound both under-count real allocation', () => {
  const b1 = attemptReservation(PHOTO_DISK_PROFILES.b1StagedHttp, 4096);
  const d1 = attemptReservation(PHOTO_DISK_PROFILES.d1CapabilityProduct, 4096);
  const viaHttp = attemptReservation(PHOTO_DISK_PROFILES.d1CapabilityProductViaHttp, 4096);
  const deterministic = attemptReservation(PHOTO_DISK_PROFILES.d1CapabilityDeterministic, 4096);
  assert.ok(b1.bytes > 42 * MiB, 'Multer max+1 sentinel, block rounding and the request directory exceed 42 MiB');
  assert.ok(d1.bytes > 74 * MiB);
  assert.ok(viaHttp.bytes > 84 * MiB, 'HTTP ingress plus capability re-write duplicates the input');
  assert.ok(deterministic.bytes > 64 * MiB);
  // Larger blocks only increase the reservation (monotonic, never optimistic).
  assert.ok(attemptReservation(PHOTO_DISK_PROFILES.b1StagedHttp, 65536).bytes > b1.bytes);
  assert.throws(() => attemptReservation(PHOTO_DISK_PROFILES.b1StagedHttp, 0), /PHOTO_DISK_INVALID_BLOCK_SIZE/);
  record('profiles', { b1, d1, viaHttp, deterministic });
});

test('42-versus-74: a budget sized for one B1 attempt admits B1 and rejects D1 whole, writing nothing', () => {
  const box = sandbox();
  const b1 = attemptReservation(PHOTO_DISK_PROFILES.b1StagedHttp, 4096).bytes;
  const budget = budgetFor(box, { budgetBytes: b1 });
  assert.throws(() => budget.reserve(PHOTO_DISK_PROFILES.d1CapabilityProduct, 'd1'), /PHOTO_DISK_BUDGET_EXHAUSTED/);
  assert.deepEqual(records(box), [], 'rejected attempt leaves no partial reservation');
  const reservation = budget.reserve(PHOTO_DISK_PROFILES.b1StagedHttp, 'b1');
  assert.equal(reservation.bytes, b1);
  assert.throws(() => budget.reserve(PHOTO_DISK_PROFILES.b1StagedHttp, 'second'), /PHOTO_DISK_BUDGET_EXHAUSTED/);
  reservation.release();
  assert.deepEqual(records(box), []);
  // The B1 aggregate (128 MiB) admits only one D1-via-HTTP attempt, never the three B1 assumed.
  const aggregate = budgetFor(sandbox(), { budgetBytes: 128 * MiB });
  aggregate.reserve(PHOTO_DISK_PROFILES.d1CapabilityProductViaHttp, 'first');
  assert.throws(() => aggregate.reserve(PHOTO_DISK_PROFILES.d1CapabilityProductViaHttp, 'second'), /PHOTO_DISK_BUDGET_EXHAUSTED/);
});

test('retained inventory: hardlinks count once, zero-byte placeholders count an inode, retained bytes shrink admission', () => {
  const box = sandbox();
  const payload = path.join(box.accounted, 'sealed.webp');
  fs.writeFileSync(payload, Buffer.alloc(3 * MiB + 1, 7));
  let linked = true;
  try { fs.linkSync(payload, path.join(box.accounted, 'canonical-link.webp')); } catch { linked = false; }
  fs.writeFileSync(path.join(box.accounted, 'reserved-placeholder.webp'), '');
  const inv = measurePhotoInventory([box.accounted], 4096);
  assert.ok(inv.bytes >= 3 * MiB + 4096 && inv.bytes < 3 * MiB + 4 * 4096, `deduplicated bytes ${inv.bytes}`);
  assert.equal(inv.inodes, 2, 'payload (+ its hardlink) and the zero-byte placeholder');
  assert.equal(inv.entries, linked ? 3 : 2);
  const b1 = attemptReservation(PHOTO_DISK_PROFILES.b1StagedHttp, 4096).bytes;
  const budget = budgetFor(box, { budgetBytes: b1 + 2 * MiB, space: roomySpace });
  assert.throws(() => budget.reserve(PHOTO_DISK_PROFILES.b1StagedHttp, 'b1'), /PHOTO_DISK_BUDGET_EXHAUSTED/, 'retained 3 MiB leaves less than one reservation');
  record('hardlink-zero-byte', { inventory: inv, linked });
});

test('free-space and inode floors reject before any record is written; accounting failure fails closed', () => {
  const box = sandbox();
  const need = attemptReservation(PHOTO_DISK_PROFILES.b1StagedHttp, 4096).bytes;
  const floor = 256 * MiB;
  const tight = budgetFor(box, { freeSpaceFloorBytes: floor, space: () => ({ blockBytes: 4096, freeBytes: floor + need - 1, freeInodes: null }) });
  assert.throws(() => tight.reserve(PHOTO_DISK_PROFILES.b1StagedHttp, 'b1'), /PHOTO_DISK_FREE_SPACE_FLOOR/);
  const exact = budgetFor(box, { freeSpaceFloorBytes: floor, space: () => ({ blockBytes: 4096, freeBytes: floor + need, freeInodes: null }) });
  exact.reserve(PHOTO_DISK_PROFILES.b1StagedHttp, 'b1').release();
  const inodes = budgetFor(box, { freeInodeFloor: 100, space: () => ({ blockBytes: 4096, freeBytes: 1024 * MiB, freeInodes: 100 }) });
  assert.throws(() => inodes.reserve(PHOTO_DISK_PROFILES.b1StagedHttp, 'b1'), /PHOTO_DISK_FREE_INODE_FLOOR/);
  const broken = budgetFor(box, { space: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } });
  assert.throws(() => broken.reserve(PHOTO_DISK_PROFILES.b1StagedHttp, 'b1'), /PHOTO_DISK_ACCOUNTING_UNAVAILABLE/);
  // Outstanding reservations are subtracted from free space too (a race with another admitted writer).
  const shared = budgetFor(box, { freeSpaceFloorBytes: 0, space: () => ({ blockBytes: 4096, freeBytes: need * 2 - 1, freeInodes: null }) });
  const held = shared.reserve(PHOTO_DISK_PROFILES.b1StagedHttp, 'first');
  assert.throws(() => shared.reserve(PHOTO_DISK_PROFILES.b1StagedHttp, 'second'), /PHOTO_DISK_FREE_SPACE_FLOOR/);
  held.release();
  assert.deepEqual(records(box), []);
});

test('unsafe inventory and malformed records fail closed', { skip: process.platform === 'win32' && 'symlink creation needs privilege on Windows' }, () => {
  const box = sandbox();
  fs.symlinkSync(os.tmpdir(), path.join(box.accounted, 'escape'));
  assert.throws(() => budgetFor(box).reserve(PHOTO_DISK_PROFILES.b1StagedHttp, 'b1'), /PHOTO_DISK_INVENTORY_UNSAFE/);
});

test('malformed or tampered reservation records are retained and fail closed', () => {
  const box = sandbox();
  const budget = budgetFor(box);
  const reservation = budget.reserve(PHOTO_DISK_PROFILES.b1StagedHttp, 'b1');
  const file = path.join(box.budgetRoot, 'reservations', `${reservation.id}.json`);
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.unlinkSync(file);
  fs.writeFileSync(file, JSON.stringify({ ...original, nonce: 'someone-else' }));
  assert.throws(() => reservation.release(), /PHOTO_DISK_RECORD_CHANGED_RETAINED/);
  assert.ok(fs.existsSync(file), 'a changed record is never removed');
  fs.writeFileSync(path.join(box.budgetRoot, 'reservations', 'garbage.json'), '{not json');
  assert.throws(() => budget.reserve(PHOTO_DISK_PROFILES.b1StagedHttp, 'next'), /PHOTO_DISK_RECORD_UNSAFE/);
});

test('close() is persistent across instances and has no reopen path', () => {
  const box = sandbox();
  const a = budgetFor(box);
  const held = a.reserve(PHOTO_DISK_PROFILES.b1StagedHttp, 'b1');
  a.close('ENOSPC during output write');
  a.close('second close is idempotent');
  const b = budgetFor(box);
  assert.throws(() => b.reserve(PHOTO_DISK_PROFILES.b1StagedHttp, 'b1'), /PHOTO_DISK_BUDGET_REVIEW_REQUIRED/);
  assert.equal(b.snapshot().closed, true);
  held.release(); // a live writer may still settle its own record while closed
  assert.throws(() => b.reserve(PHOTO_DISK_PROFILES.b1StagedHttp, 'b1'), /PHOTO_DISK_BUDGET_REVIEW_REQUIRED/);
  assert.equal(typeof b.reopen, 'undefined');
});

test('constructor refuses non-development environments and non-disposable roots', () => {
  const box = sandbox();
  const previous = process.env.PRODUCT_PHOTO_DISK_STAGING_ENABLED;
  try {
    process.env.PRODUCT_PHOTO_DISK_STAGING_ENABLED = 'false';
    assert.throws(() => budgetFor(box), /PHOTO_DEVELOPMENT_DISK_BUDGET_DISABLED/);
  } finally { process.env.PRODUCT_PHOTO_DISK_STAGING_ENABLED = previous; }
  assert.throws(() => new DevelopmentPhotoDiskBudget({ budgetRoot: path.join(os.homedir(), 'photo-budget'), accountedRoots: [], budgetBytes: 1, freeSpaceFloorBytes: 0 }), /PHOTO_DISPOSABLE_DISK_BUDGET_REQUIRED/);
});

function startWorker(mode, options) {
  const child = spawn(process.execPath, ['--import', 'tsx', worker, mode, JSON.stringify(options)], { stdio: ['ignore', 'pipe', 'pipe'], cwd: path.resolve(__dirname, '../..') });
  const events = [];
  let buffer = '', stderr = '';
  const waiters = [];
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const event = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1); events.push(event);
      for (const waiter of waiters.splice(0)) waiter();
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const next = (predicate, ms = 60_000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`worker timeout; stderr: ${stderr}`)), ms);
    const check = () => { const hit = events.find(predicate); if (hit) { clearTimeout(timer); resolve(hit); } else waiters.push(check); };
    check();
  });
  return { child, events, next, exited, stderr: () => stderr };
}

test('cross-process race: concurrent writers never over-commit the shared budget', { timeout: 180_000 }, async () => {
  const box = sandbox();
  const b1 = attemptReservation(PHOTO_DISK_PROFILES.b1StagedHttp, 4096).bytes;
  const capacity = 3;
  const options = { budget: { budgetRoot: box.budgetRoot, accountedRoots: [box.accounted], budgetBytes: capacity * b1, freeSpaceFloorBytes: 0, lockWaitMs: 30_000 }, profile: 'b1StagedHttp', startAt: Date.now() + 8000, exit: true };
  const workers = Array.from({ length: 6 }, (_, i) => startWorker('reserve-and-hold', { ...options, label: `w${i}` }));
  const outcomes = await Promise.all(workers.map((w) => w.next(() => true, 120_000)));
  await Promise.all(workers.map((w) => w.exited));
  const reserved = outcomes.filter((o) => o.event === 'reserved');
  const rejected = outcomes.filter((o) => o.event === 'rejected');
  assert.equal(reserved.length, capacity, JSON.stringify(outcomes));
  assert.ok(rejected.every((o) => o.code === 'PHOTO_DISK_BUDGET_EXHAUSTED'), JSON.stringify(rejected));
  // Exited holders never released: their records stay and keep counting (crash-retained semantics).
  assert.equal(records(box).length, capacity);
  const snapshot = budgetFor(box).snapshot();
  assert.ok(snapshot.reservedBytes <= capacity * b1);
  record('cross-process-race', { capacity, outcomes, snapshot });
});

test('SIGKILL while holding a reservation retains its record and keeps counting it', { timeout: 120_000 }, async () => {
  const box = sandbox();
  const b1 = attemptReservation(PHOTO_DISK_PROFILES.b1StagedHttp, 4096).bytes;
  const w = startWorker('reserve-and-hold', { budget: { budgetRoot: box.budgetRoot, accountedRoots: [box.accounted], budgetBytes: b1, freeSpaceFloorBytes: 0 }, profile: 'b1StagedHttp', label: 'killed', startAt: 0 });
  const reserved = await w.next((e) => e.event === 'reserved');
  w.child.kill('SIGKILL');
  const exit = await w.exited;
  assert.deepEqual(records(box), [`${reserved.id}.json`]);
  assert.throws(() => budgetFor(box, { budgetBytes: b1 }).reserve(PHOTO_DISK_PROFILES.b1StagedHttp, 'after'), /PHOTO_DISK_BUDGET_EXHAUSTED/);
  record('sigkill-reservation', { exit, retained: records(box) });
});

test('SIGKILL inside the exclusive ledger section leaves every process BUSY until review', { timeout: 120_000 }, async () => {
  const box = sandbox();
  const w = startWorker('block-inside-ledger', { budget: { budgetRoot: box.budgetRoot, accountedRoots: [box.accounted], budgetBytes: 1024 * MiB, freeSpaceFloorBytes: 0 } });
  await w.next((e) => e.event === 'inside-lock');
  w.child.kill('SIGKILL');
  const exit = await w.exited;
  const lock = path.join(box.budgetRoot, 'ledger.lock');
  assert.ok(fs.existsSync(lock), 'the crashed holder lock is retained (no PID/age reclaim)');
  assert.throws(() => budgetFor(box, { lockWaitMs: 200 }).reserve(PHOTO_DISK_PROFILES.b1StagedHttp, 'after'), /PHOTO_DISK_BUDGET_BUSY/);
  assert.deepEqual(records(box), []);
  record('sigkill-ledger-lock', { exit, lockRetained: fs.existsSync(lock) });
});

const enospc = process.env.NOCTELLA_DISK_BUDGET_ENOSPC === '1';
test('real filesystem: statfs-based admission and an actual ENOSPC fail closed without deleting bytes', { skip: !enospc && 'set NOCTELLA_DISK_BUDGET_ENOSPC=1 with TMPDIR on a small dedicated filesystem', timeout: 180_000 }, async () => {
  const box = sandbox();
  const space = readFilesystemSpace(box.root);
  const budget = new DevelopmentPhotoDiskBudget({ budgetRoot: box.budgetRoot, accountedRoots: [box.accounted], budgetBytes: 1024 * MiB, freeSpaceFloorBytes: 0 });
  const d1 = attemptReservation(PHOTO_DISK_PROFILES.d1CapabilityProduct, space.blockBytes).bytes;
  const b1 = attemptReservation(PHOTO_DISK_PROFILES.b1StagedHttp, space.blockBytes).bytes;
  assert.ok(space.freeBytes < d1 && space.freeBytes >= b1, `test filesystem must fit B1 but not D1 (free ${space.freeBytes})`);
  assert.throws(() => budget.reserve(PHOTO_DISK_PROFILES.d1CapabilityProduct, 'd1'), /PHOTO_DISK_FREE_SPACE_FLOOR/);
  const held = budget.reserve(PHOTO_DISK_PROFILES.b1StagedHttp, 'b1');
  // An unbudgeted writer (legacy/bypass path or output overshoot) fills the filesystem for real.
  const filler = path.join(box.accounted, 'unbudgeted-writer.bin');
  const fd = fs.openSync(filler, 'wx', 0o600);
  let written = 0, error = null;
  const chunk = Buffer.alloc(MiB, 0xab);
  try { for (;;) written += fs.writeSync(fd, chunk); } catch (e) { error = e; } finally { try { fs.closeSync(fd); } catch (e) { error = error ?? e; } }
  assert.equal(error?.code, 'ENOSPC');
  budget.close('ENOSPC observed by writer');
  const stat = fs.statSync(filler);
  assert.ok(fs.existsSync(filler), 'partial bytes are retained, never deleted automatically');
  assert.throws(() => budget.reserve(PHOTO_DISK_PROFILES.b1StagedHttp, 'after'), /PHOTO_DISK_BUDGET_REVIEW_REQUIRED/);
  held.release();
  record('real-enospc', { space, written, partial: { size: stat.size, blocks: stat.blocks }, after: readFilesystemSpace(box.root), b1, d1 });
});
