// #390 EXPERIMENT (owner-authorized, isolated): W3/W4 fidelity of original-source staging versus the live WebP-first
// pipeline. Synthetic fixtures only; disposable /work; no network. Each workflow runs in its own child process so its
// peak RSS is separable. A = live LocalAiIntakePhotoStorage + live writeDeterministicProductPhoto (W4).
// B = experimental original-source staging + the same live W4. Results: /evidence/fidelity.json.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { buildExifTiff, insertExifApp1, psnr, ssimLuma, scanMarkers } from "./w3-fidelity-lib.mjs";

const appRequire = createRequire("/app/apps/api/package.json");
const dist = (module: string) => appRequire("/app/apps/api/dist/" + module);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const MARKERS = ["SERIAL-390-TEST", "GPS-390-DATUM", "SyntheticCam"];
const PRODUCT = "11111111-1111-4111-8111-111111111111", PHOTO = "22222222-2222-4222-8222-222222222222";

async function one(spec: { input: string; mimetype: string; workflow: "A" | "B" | "B-validate"; out: string }) {
  const sharp = appRequire("sharp");
  const bytes = fs.readFileSync(spec.input);
  const started = Date.now();
  const result: Record<string, unknown> = { workflow: spec.workflow };
  try {
    let staged: Buffer, stagedKey: string;
    if (spec.workflow === "A") {
      const { LocalAiIntakePhotoStorage } = dist("services/aiIntakePhotoStorage.js");
      stagedKey = (await new LocalAiIntakePhotoStorage(path.join(spec.out, "staging")).saveIntakePhoto({ buffer: bytes, mimetype: spec.mimetype, size: bytes.length })).storageKey;
    } else {
      const experiment = dist("scripts/experiments/originalSourceIntakeStaging.js");
      if (spec.workflow === "B-validate") { result.validation = await experiment.validateOriginalSource(bytes, spec.mimetype, bytes.length); result.stageMs = Date.now() - started; return finish(result); }
      stagedKey = (await experiment.stageOriginalSource(path.join(spec.out, "staging"), { buffer: bytes, mimetype: spec.mimetype, size: bytes.length })).storageKey;
      result.preview = path.join(spec.out, "preview.webp");
      fs.writeFileSync(result.preview as string, await experiment.previewOriginalSource(path.join(spec.out, "staging"), stagedKey));
    }
    staged = fs.readFileSync(path.join(spec.out, "staging", stagedKey));
    Object.assign(result, { stagedKey, stagedPath: path.join(spec.out, "staging", stagedKey), stagedBytes: staged.length, stagedSha: sha(staged), stagedMeta: pick(await sharp(staged).metadata()), stageMs: Date.now() - started });
    const w4Start = Date.now();
    const { writeDeterministicProductPhoto } = dist("services/photoStorage.js");
    // Exactly the live W4 manifest call (use-cases/ai-intake-photo-finalize): staged bytes labelled image/webp.
    const written = await writeDeterministicProductPhoto({ buffer: staged, mimetype: "image/webp", size: staged.length, mainStorageKey: `${PRODUCT}-${PHOTO}.webp`, thumbnailStorageKey: `${PRODUCT}-${PHOTO}-thumb.webp` });
    Object.assign(result, { w4Ms: Date.now() - w4Start, written });
  } catch (error: any) {
    Object.assign(result, { rejected: true, errorName: error?.constructor?.name, status: error?.statusCode ?? error?.status ?? null, reason: error?.reason ?? null, message: String(error?.message ?? error).slice(0, 200), leftovers: fs.existsSync(path.join(spec.out, "staging")) ? fs.readdirSync(path.join(spec.out, "staging")) : [] });
  }
  return finish(result);
  function finish(r: Record<string, unknown>) { r.maxRssBytes = process.resourceUsage().maxRSS * 1024; r.totalMs = Date.now() - started; process.stdout.write("\n" + JSON.stringify(r) + "\n"); }
}

const pick = (m: any) => ({ format: m.format, width: m.width, height: m.height, channels: m.channels, orientation: m.orientation ?? null, hasExif: !!m.exif, hasIcc: !!m.icc, pages: m.pages ?? 1 });

function child(input: string, mimetype: string, workflow: string, out: string) {
  fs.mkdirSync(path.join(out, "photos"), { recursive: true });
  const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/photo-upload-linux/w3-fidelity.ts", "one", JSON.stringify({ input, mimetype, workflow, out })], {
    cwd: "/app", encoding: "utf8", maxBuffer: 1 << 20, timeout: 240000,
    env: { ...process.env, PRODUCT_PHOTO_DIR: path.join(out, "photos"), PRODUCT_PHOTO_DISK_STAGING_ENABLED: "", NODE_ENV: "test" },
  });
  const line = (run.stdout ?? "").trim().split("\n").pop() ?? "";
  try { return { ...JSON.parse(line), exitCode: run.status, signal: run.signal }; }
  catch { return { workflow, crashed: true, exitCode: run.status, signal: run.signal, stderr: (run.stderr ?? "").slice(-2000) }; }
}

async function decode(sharp: any, input: Buffer | string, reference = false) {
  let image = sharp(input, { failOn: "error" });
  if (reference) image = image.rotate().resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true });
  return image.removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
}

export async function runFidelity() {
  const sharp = appRequire("sharp");
  const { isPrivateStagedFilename } = dist("use-cases/ai-intake-cleanup/useCases.js");
  const experiment = dist("scripts/experiments/originalSourceIntakeStaging.js");
  const fixtures = JSON.parse(fs.readFileSync("/fixtures/fixtures.json", "utf8"));
  const file = (name: string) => { const f = fixtures.find((x: any) => x.name === name); if (!f) throw Error("Missing fixture " + name); return { path: path.join("/fixtures", path.basename(f.file)), mimetype: f.mimetype, sizeBytes: f.sizeBytes }; };
  const root = "/work/fidelity";
  fs.mkdirSync(path.join(root, "inputs"), { recursive: true });
  // EXIF/GPS/serial + Display P3 + orientation 6 fixture built from the 12MP synthetic JPEG's pixels.
  const p3 = await sharp(file("jpeg-typical-landscape").path).withIccProfile("p3").jpeg({ quality: 92 }).toBuffer();
  const exifJpeg = insertExifApp1(p3, buildExifTiff({ make: "SyntheticCam", orientation: 6, serial: "SERIAL-390-TEST", datum: "GPS-390-DATUM" }));
  fs.writeFileSync(path.join(root, "inputs", "jpeg-exif-gps-p3-orient6.jpg"), exifJpeg);
  const truncatedSource = fs.readFileSync(file("jpeg-typical-landscape").path);
  fs.writeFileSync(path.join(root, "inputs", "truncated.jpg"), truncatedSource.subarray(0, Math.floor(truncatedSource.length * 0.6)));

  const valid = [
    { name: "jpeg-near-limit", ...file("jpeg-near-limit") },
    { name: "webp-near-limit", ...file("webp-near-limit") },
    { name: "png-near-limit", ...file("png-near-limit") },
    { name: "jpeg-exif-gps-p3-orient6", path: path.join(root, "inputs", "jpeg-exif-gps-p3-orient6.jpg"), mimetype: "image/jpeg" },
  ];
  const report: any = { generatedAt: new Date().toISOString(), sharp: sharp.versions, node: process.version, method: "A = live W3 LocalAiIntakePhotoStorage + live W4 writeDeterministicProductPhoto; B = experimental original-source staging + same live W4. Reference = original decoded, auto-oriented, resized 2000 inside (lanczos3), sRGB, no lossy encode. SSIM = mean BT.601 luma SSIM over 8x8 windows.", cases: [], invalid: [], stress: null, legacy: {}, crash: {} };

  for (const input of valid) {
    const A = child(input.path, input.mimetype, "A", path.join(root, input.name, "A"));
    const B = child(input.path, input.mimetype, "B", path.join(root, input.name, "B"));
    const entry: any = { input: input.name, inputBytes: fs.statSync(input.path).size, inputSha: sha(fs.readFileSync(input.path)), inputMeta: pick(await sharp(input.path).metadata()), A: summarize(A), B: summarize(B) };
    if (!A.rejected && !B.rejected && !A.crashed && !B.crashed) {
      entry.B.stagedEqualsInput = B.stagedSha === entry.inputSha;
      const reference = await decode(sharp, input.path, true);
      for (const kind of ["main", "thumb"] as const) {
        const fa = path.join(root, input.name, "A", "photos", `${PRODUCT}-${PHOTO}${kind === "thumb" ? "-thumb" : ""}.webp`);
        const fb = path.join(root, input.name, "B", "photos", `${PRODUCT}-${PHOTO}${kind === "thumb" ? "-thumb" : ""}.webp`);
        const [ba, bb] = [fs.readFileSync(fa), fs.readFileSync(fb)];
        const [da, db] = [await decode(sharp, fa), await decode(sharp, fb)];
        const cmp: any = { A: { bytes: ba.length, sha: sha(ba), ...pick(await sharp(ba).metadata()), markers: scanMarkers(ba, MARKERS) }, B: { bytes: bb.length, sha: sha(bb), ...pick(await sharp(bb).metadata()), markers: scanMarkers(bb, MARKERS) } };
        cmp.byteIdentical = cmp.A.sha === cmp.B.sha;
        cmp.sameDimensions = da.info.width === db.info.width && da.info.height === db.info.height;
        if (cmp.sameDimensions) { cmp.psnrAvsB = psnr(da.data, db.data); cmp.ssimAvsB = ssimLuma(da.data, db.data, da.info.width, da.info.height, 3); }
        if (kind === "main" && reference.info.width === da.info.width && reference.info.height === da.info.height && cmp.sameDimensions) {
          cmp.vsReference = { psnrA: psnr(da.data, reference.data), psnrB: psnr(db.data, reference.data), ssimA: ssimLuma(da.data, reference.data, da.info.width, da.info.height, 3), ssimB: ssimLuma(db.data, reference.data, db.info.width, db.info.height, 3) };
        } else if (kind === "main") cmp.vsReference = { skipped: "reference dimensions differ", reference: [reference.info.width, reference.info.height] };
        entry[kind] = cmp;
      }
    } else entry.comparison = { skipped: "A or B did not complete W3+W4", A: A.rejected || A.crashed ? (A.message ?? A.stderr ?? "crashed") : "completed", B: B.rejected || B.crashed ? (B.message ?? B.stderr ?? "crashed") : "completed" };
    // Privacy and naming are recorded for each workflow independently, so one side's rejection never hides the other.
    entry.privacy = {
      A_stagedServedByAdminRoute: A.stagedPath ? scanMarkers(fs.readFileSync(A.stagedPath), MARKERS) : null,
      B_stagedRaw: B.stagedPath ? scanMarkers(fs.readFileSync(B.stagedPath), MARKERS) : null,
      B_preview: B.preview && fs.existsSync(B.preview) ? { markers: scanMarkers(fs.readFileSync(B.preview), MARKERS), ...pick(await sharp(B.preview).metadata()) } : null,
      note: "Live AiIntakePhotoReader (W4 and future AI providers) returns raw staged bytes: under B that is the original with EXIF/GPS unless a provider-safe reader (previewOriginalSource) is used.",
    };
    entry.legacy = { A_keyMatchesLiveCleanup: A.stagedKey ? isPrivateStagedFilename(A.stagedKey) : null, B_keyMatchesLiveCleanup: B.stagedKey ? isPrivateStagedFilename(B.stagedKey) : null, B_keyMatchesExperiment: B.stagedKey ? experiment.ORIGINAL_SOURCE_KEY_RE.test(B.stagedKey) : null };
    report.cases.push(entry);
  }

  const invalid = [
    { name: "invalid-random-bytes", path: file("invalid-random-bytes").path, mimetype: "image/jpeg" },
    { name: "truncated-jpeg", path: path.join(root, "inputs", "truncated.jpg"), mimetype: "image/jpeg" },
    { name: "png-declared-as-jpeg", path: file("png-near-limit").path, mimetype: "image/jpeg" },
    { name: "jpeg-declared-as-gif", path: file("jpeg-typical-landscape").path, mimetype: "image/gif" },
  ];
  for (const input of invalid) {
    const A = child(input.path, input.mimetype, "A", path.join(root, "invalid-" + input.name, "A"));
    const B = child(input.path, input.mimetype, "B", path.join(root, "invalid-" + input.name, "B"));
    report.invalid.push({ input: input.name, A: summarize(A), B: summarize(B) });
  }
  // Decompression stress: B validates by streaming decode only. A (full 144-MP WebP encode) is not run here.
  report.stress = { input: "png-stress-144mp", B: summarize(child(file("png-stress-144mp").path, "image/png", "B-validate", path.join(root, "stress", "B"))), A: "not run: the live W3 path performs a full-resolution 144-MP WebP encode" };

  // Crash leftovers: only the experimental partial shape is swept, and only after the grace period.
  const crashRoot = path.join(root, "crash");
  fs.mkdirSync(crashRoot, { recursive: true });
  const partial = `.${"33333333-3333-4333-8333-333333333333"}.partial`, foreign = "44444444-4444-4444-8444-444444444444.webp";
  fs.writeFileSync(path.join(crashRoot, partial), "x"); fs.writeFileSync(path.join(crashRoot, foreign), "x");
  report.crash = { sweptWithinGrace: await experiment.sweepPartials(crashRoot, 60000), sweptAfterGrace: await experiment.sweepPartials(crashRoot, 60000, Date.now() + 120000), remaining: fs.readdirSync(crashRoot), partialMatchesLiveCleanup: isPrivateStagedFilename(partial) };
  fs.writeFileSync("/evidence/fidelity.json", JSON.stringify(report, (_key, value) => value === Infinity ? "Infinity" : value, 2));
  fs.rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify({ fidelity: report.cases.map((c: any) => ({ input: c.input, main: c.main && { identical: c.main.byteIdentical, psnrAvsB: c.main.psnrAvsB, ssimAvsB: c.main.ssimAvsB }, rssA: c.A.maxRssBytes, rssB: c.B.maxRssBytes })) }));
}

function summarize(r: any) {
  const { stagedPath, preview, ...rest } = r;
  return rest;
}

if (process.argv[2] === "one") one(JSON.parse(process.argv[3])).catch(error => { console.error(String(error)); process.exitCode = 2; });
