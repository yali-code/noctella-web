'use strict';
// P2-2B3D2 (#407): measures the real per-attempt disk footprint of
//   (a) the existing gated staged HTTP storage (42 MiB reservation, B1), and
//   (b) the development sealed storage capability from #406 (74 MiB policy bound),
// using synthetic near-limit and maximum-entropy fixtures, the actual production
// recipes and disposable os.tmpdir()/noctella-photo-fence-* roots. Read-only
// with respect to the repository; no network, credentials, production data or
// provider calls. Usage: node --import tsx scripts/photo-disk-budget/measure.cjs [--quick] [--out file.json]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { fixture, adapter, api } = require('../photo-storage-capability/fixture.cjs');
const { inventory, clusterBytes } = require('./inventory.cjs');
const sharp = api('sharp');
const { DevelopmentPhotoStorageCapability } = require('../../apps/api/src/services/developmentPhotoStorageCapability.ts');
const { LocalStagedProductPhotoStorage } = require('../../apps/api/src/services/stagedProductPhotoStorage.ts');

const MiB = 1024 * 1024;
const INPUT_LIMIT = 10 * MiB;

function prng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function pixels(width, height, channels, noise, seed) {
  const random = prng(seed), out = Buffer.allocUnsafe(width * height * channels);
  let o = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const base = [(x * 255) / width, (y * 255) / height, 128, 255];
    for (let c = 0; c < channels; c++) { const v = (c === 3 && noise < 127 ? 255 : base[c]) + (random() * 2 - 1) * noise; out[o++] = v < 0 ? 0 : v > 255 ? 255 : v; }
  }
  return out;
}
/** Encodes at the highest quality (or largest height for PNG) that still fits the 10 MiB input limit. */
async function nearLimit(spec) {
  let { width, height } = spec;
  for (let attempt = 0; attempt < 40; attempt++) {
    const raw = pixels(width, height, spec.channels, spec.noise, spec.seed);
    const image = () => sharp(raw, { raw: { width, height, channels: spec.channels } });
    if (spec.format === 'png') {
      const bytes = await image().png({ compressionLevel: 6 }).toBuffer();
      if (bytes.length <= INPUT_LIMIT) return { bytes, width, height };
      height = Math.floor(height * 0.95);
      continue;
    }
    for (let quality = 100; quality >= 40; quality -= 2) {
      const bytes = await image()[spec.format]({ quality, ...(spec.format === 'jpeg' ? { chromaSubsampling: '4:4:4' } : {}) }).toBuffer();
      if (bytes.length <= INPUT_LIMIT) return { bytes, width, height, quality };
    }
    height = Math.floor(height * 0.9);
  }
  throw new Error(`Cannot fit ${spec.name} under the input limit`);
}

const FULL_FIXTURES = [
  { name: 'jpeg-24mp-near-limit', format: 'jpeg', width: 6000, height: 4000, channels: 3, noise: 40, seed: 1 },
  { name: 'webp-24mp-near-limit', format: 'webp', width: 6000, height: 4000, channels: 3, noise: 48, seed: 2 },
  { name: 'png-near-limit', format: 'png', width: 2600, height: 2000, channels: 3, noise: 36, seed: 3 },
  { name: 'jpeg-2000px-max-entropy', format: 'jpeg', width: 2000, height: 2000, channels: 3, noise: 127, seed: 4 },
  { name: 'png-rgba-max-entropy', format: 'png', width: 1700, height: 1700, channels: 4, noise: 127, seed: 5 },
];
const QUICK_FIXTURES = [
  { name: 'jpeg-quick', format: 'jpeg', width: 320, height: 240, channels: 3, noise: 60, seed: 11 },
  { name: 'png-rgba-quick', format: 'png', width: 200, height: 260, channels: 4, noise: 127, seed: 12 },
];

const isProbeDb = (file) => /probe\.sqlite/.test(path.basename(file));
function dbBytes(root) {
  return fs.readdirSync(root).filter((name) => /probe\.sqlite/.test(name)).reduce((total, name) => total + fs.statSync(path.join(root, name)).size, 0);
}

/** B1: the gated HTTP route's request directory + the actual LocalStagedProductPhotoStorage. */
async function measureStaged(input) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noctella-photo-fence-'));
  const staging = path.join(root, 'staging'), canonical = path.join(root, 'canonical');
  const checkpoints = [];
  const snap = (name) => checkpoints.push({ name, ...inventory([staging, canonical]) });
  try {
    fs.mkdirSync(staging, { mode: 0o700 }); fs.mkdirSync(canonical);
    const workDir = fs.mkdtempSync(path.join(staging, 'request-'));
    const file = path.join(workDir, 'input');
    fs.writeFileSync(file, input.bytes, { flag: 'wx', mode: 0o600 });
    snap('input-received');
    const encode = async (image, destination) => { snap(`reserved-${path.basename(destination)}`); const result = await image.toFile(destination); snap(`encoded-${path.basename(destination)}`); return result; };
    const publish = async (source, destination) => { await fs.promises.link(source, destination); snap(`published-${path.basename(source)}`); };
    const storage = new LocalStagedProductPhotoStorage(canonical, publish, encode);
    const photo = await storage.saveStagedProductPhoto({ path: file, workDir, mimetype: input.mimetype, size: input.bytes.length, signal: new AbortController().signal });
    fs.rmSync(workDir, { recursive: true, force: true });
    snap('request-cleaned');
    const files = listing([staging, canonical], root);
    const peak = checkpoints.reduce((best, item) => (item.conservativeBytes > best.conservativeBytes ? item : best));
    const outputs = fs.readdirSync(canonical).map((name) => ({ name, size: fs.statSync(path.join(canonical, name)).size }));
    return { path: 'b1-staged-http', photo: { width: photo.width, height: photo.height }, outputs, peak: { checkpoint: peak.name, ...pick(peak) }, final: pick(checkpoints.at(-1)), checkpoints: checkpoints.map((c) => ({ name: c.name, ...pick(c) })), files };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function listing(roots, base) {
  const rows = [];
  const walk = (dir) => {
    let list; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of list) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!entry.isFile() || isProbeDb(file)) continue;
      const stat = fs.statSync(file, { bigint: true });
      rows.push({ path: path.relative(base, file).split(path.sep).join('/'), ino: stat.ino.toString(), nlink: Number(stat.nlink), bytes: Number(stat.size), blocks: process.platform === 'win32' ? null : Number(stat.blocks), sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
    }
  };
  for (const root of roots) walk(root);
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

function pick(item) {
  const { cluster, inodes, zeroByteInodes, directories, logicalBytes, logicalBytesPerPath, clusterRoundedBytes, posixAllocatedBytes, directoryAllocatedBytes, conservativeBytes } = item;
  return { cluster, inodes, zeroByteInodes, directories, logicalBytes, logicalBytesPerPath, clusterRoundedBytes, posixAllocatedBytes, directoryAllocatedBytes, conservativeBytes };
}

/** D1: the development sealed capability (SQLite authority), optionally beside an HTTP ingress input. */
async function measureCapability(input, kind, options = {}) {
  const f = await fixture('sqlite');
  const ingress = path.join(f.root, 'ingress');
  const roots = [path.join(f.root, 'private'), path.join(f.root, 'canonical'), ingress];
  const checkpoints = [];
  const snap = (name) => checkpoints.push({ name, ...inventory(roots, { skip: isProbeDb }), databaseBytes: dbBytes(f.root) });
  try {
    const hash = crypto.createHash('sha256').update(input.bytes).digest('hex');
    const cap = new DevelopmentPhotoStorageCapability(adapter(f.p, hash), roots[0], roots[1]);
    fs.mkdirSync(ingress, { mode: 0o700 });
    if (options.httpIngress) fs.writeFileSync(path.join(ingress, 'input'), input.bytes, { flag: 'wx', mode: 0o600 });
    snap('start');
    const prepare = (token, now) => (kind === 'deterministic' ? cap.prepareDeterministic(token, now, input.bytes, input.mimetype) : cap.prepareProduct(token, now, input.bytes, input.mimetype));
    const first = await cap.begin('op', 'a', 'claim-a', 100, 100);
    const sealA = await prepare(first, 101);
    snap('attempt-1-sealed');
    await cap.publish(first, 102, sealA);
    snap('attempt-1-published');
    let retained = null;
    if (options.retry) {
      // Reclaim after an ambiguous outcome: the first generation's private bytes stay retained.
      const second = await cap.reclaim('op', 1, 'b', 'claim-b', 300, 100);
      const sealB = await prepare(second, 301);
      snap('attempt-2-sealed');
      await cap.publish(second, 302, sealB);
      snap('attempt-2-published');
      retained = checkpoints.at(-1).conservativeBytes - checkpoints.find((c) => c.name === 'attempt-1-published').conservativeBytes;
    }
    const peak = checkpoints.reduce((best, item) => (item.conservativeBytes > best.conservativeBytes ? item : best));
    const files = listing(roots, f.root);
    return { files, path: `d1-capability-${kind}${options.httpIngress ? '+http-ingress' : ''}${options.retry ? '+reclaim' : ''}`, peak: { checkpoint: peak.name, ...pick(peak) }, final: { ...pick(checkpoints.at(-1)), databaseBytes: checkpoints.at(-1).databaseBytes }, secondAttemptGrowthBytes: retained, checkpoints: checkpoints.map((c) => ({ name: c.name, ...pick(c), databaseBytes: c.databaseBytes })) };
  } finally {
    await f.p.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const quick = args.includes('--quick');
  const outIndex = args.indexOf('--out');
  const specs = quick ? QUICK_FIXTURES : FULL_FIXTURES;
  const results = [];
  for (const spec of specs) {
    const encoded = await nearLimit(spec);
    const input = { ...encoded, mimetype: `image/${spec.format}` };
    const fixtureInfo = { name: spec.name, format: spec.format, width: encoded.width, height: encoded.height, megapixels: +(encoded.width * encoded.height / 1e6).toFixed(2), quality: encoded.quality ?? null, bytes: encoded.bytes.length, sha256: crypto.createHash('sha256').update(encoded.bytes).digest('hex') };
    process.stderr.write(`${spec.name}: ${(encoded.bytes.length / MiB).toFixed(2)} MiB ${encoded.width}x${encoded.height}\n`);
    const runs = [
      await measureStaged(input),
      await measureCapability(input, 'product'),
      await measureCapability(input, 'product', { httpIngress: true }),
      await measureCapability(input, 'deterministic'),
      await measureCapability(input, 'product', { retry: true }),
    ];
    results.push({ fixture: fixtureInfo, runs });
  }
  const tmp = os.tmpdir();
  const report = {
    generatedAt: new Date().toISOString(),
    profile: quick ? 'quick' : 'full',
    node: process.version, platform: process.platform, release: os.release(), arch: process.arch,
    sharp: sharp.versions,
    tmpdir: { cluster: clusterBytes(tmp), statfsType: (() => { try { return Number(fs.statfsSync(tmp).type); } catch { return null; } })() },
    policy: { inputLimitBytes: INPUT_LIMIT, outputCapBytes: 16 * MiB, b1ReservationBytes: 42 * MiB, d1PolicyBoundBytes: 74 * MiB },
    results,
  };
  const json = JSON.stringify(report, null, 2);
  if (outIndex >= 0) fs.writeFileSync(args[outIndex + 1], json);
  else process.stdout.write(json + '\n');
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { measureStaged, measureCapability, nearLimit, QUICK_FIXTURES, FULL_FIXTURES };
