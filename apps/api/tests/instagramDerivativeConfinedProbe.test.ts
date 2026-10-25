/**
 * P5 Linux capability probe (real launcher; F2_CAPABILITY_LAUNCHER, required in CI): a confined `instagram` job cannot
 * write or link into the canonical, private-operation or publication roots, and nothing appears there; writing its own
 * job directory succeeds. Also proves the recipe is deterministic through the confined worker (identical bytes twice).
 */
import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { renderDerivativeInConfinedWorker } from "../src/services/photoPreparationConfinement";
import { photoOperationPrivateRoot } from "../src/services/photoOperationAuthority";
import { photoPublicationStagingRoot } from "../src/services/photoPublicationExecutor";
import { instagramDerivativeJobRoot, sha256 } from "../src/integrations/instagram/instagramDerivativeStore";

const launcher = process.env.F2_CAPABILITY_LAUNCHER;
const native = process.platform === "linux" && !!launcher;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "noctella-ig-confined-"));
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

it.runIf(process.env.F2_CAPABILITY_REQUIRE_LINUX === "1")("required: the P5 confined Instagram probe runs on Linux with the real launcher", () => {
  expect(native).toBe(true);
});

describe.runIf(native)("confined instagram job on Linux (real launcher)", () => {
  const canonical = path.join(root, "photos");
  const protectedRoots = { canonical, private: photoOperationPrivateRoot(canonical), publication: photoPublicationStagingRoot(canonical) };
  const jobDir = () => { const dir = path.join(instagramDerivativeJobRoot(canonical), `.job-${Math.random().toString(16).slice(2)}`); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; };
  for (const dir of Object.values(protectedRoots)) fs.mkdirSync(dir, { recursive: true });

  it("denies writes and hard links into every protected root because of Landlock; only its own job directory is writable", async () => {
    const fixture = path.join(__dirname, "fixtures", "instagramDerivativeEvilWorker.ts");
    const dir = jobDir();
    const labels = Object.keys(protectedRoots);

    // Precondition 1 (same filesystem): the job dir and every protected root share one device, so neither a write nor a
    // hard link can fail for cross-filesystem reasons. Fails the test (never skips) otherwise.
    for (const [label, target] of Object.entries(protectedRoots)) expect(fs.statSync(dir).dev, `${label} on the job dir's device`).toBe(fs.statSync(target).dev);

    // Precondition 2 (permissions): the SAME fixture, unconfined (plain node + tsx, same job payload), against separate
    // control copies of the three roots created the same way, can write AND link everywhere. So ordinary permissions and
    // the device allow both operations, and a denial in the confined run below can only come from Landlock.
    const controlBase = fs.mkdtempSync(path.join(root, "control-"));
    try {
      const controlCanonical = path.join(controlBase, "photos");
      const controlRoots = { canonical: controlCanonical, private: photoOperationPrivateRoot(controlCanonical), publication: photoPublicationStagingRoot(controlCanonical) };
      for (const target of Object.values(controlRoots)) fs.mkdirSync(target, { recursive: true });
      const controlDir = path.join(instagramDerivativeJobRoot(controlCanonical), ".job-control");
      fs.mkdirSync(controlDir, { recursive: true, mode: 0o700 });
      for (const [label, target] of Object.entries(controlRoots)) expect(fs.statSync(controlDir).dev, `control ${label} on one device`).toBe(fs.statSync(target).dev);
      const job = { kind: "instagram", inputPath: path.join(controlDir, "source.webp"), recipe: "instagram-v1", outDir: controlDir, probe: controlRoots };
      const run = spawnSync(process.execPath, ["--import", "tsx", fixture], {
        cwd: path.resolve(__dirname, ".."), encoding: "utf8", timeout: 60_000,
        env: { ...process.env, PHOTO_PREPARATION_JOB: Buffer.from(JSON.stringify(job)).toString("base64") },
      });
      expect(run.error).toBeUndefined();
      const control = JSON.parse(JSON.parse(run.stdout.trim().split("\n").pop()!).message);
      expect(control.ownWrite).toBe("WRITTEN");
      for (const label of labels) for (const kind of ["Write", "Link"]) expect(control[`${label}${kind}`], `unconfined control ${label}${kind}`).toBe("WRITTEN");
    } finally { fs.rmSync(controlBase, { recursive: true, force: true }); }

    // Confined run (real launcher): the same operations on the real protected roots are denied.
    let error: any;
    await renderDerivativeInConfinedWorker(launcher!, { kind: "instagram", inputPath: path.join(dir, "source.webp"), recipe: "instagram-v1", outDir: dir, probe: protectedRoots } as any, dir,
      { workerScript: fixture }).catch((e) => { error = e; });
    expect(error?.code).toBe("EVIL_REPORT");
    const report = JSON.parse(error.message);
    expect(report.ownWrite).toBe("WRITTEN");
    for (const label of labels) {
      // A plain write outside the allowed hierarchy is an access denial, never a cross-device error.
      expect(["EACCES", "EPERM"], `${label}Write`).toContain(report[`${label}Write`]);
      // Landlock reports a refused hard link (reparenting / LANDLOCK_ACCESS_FS_REFER) as EXDEV. EXDEV is accepted here only
      // because precondition 1 proved the same device, so it cannot be an ordinary cross-filesystem link failure.
      expect(["EACCES", "EPERM", "EXDEV"], `${label}Link`).toContain(report[`${label}Link`]);
    }
    for (const target of Object.values(protectedRoots)) expect(fs.readdirSync(target)).toEqual([]);
    expect(fs.readFileSync(path.join(dir, "own.txt"), "utf8")).toBe("ok");
  });

  it("renders deterministically through the confined worker (identical bytes for identical input)", async () => {
    const source = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#406080" } }).webp().toBuffer();
    const render = async () => { const dir = jobDir(); fs.writeFileSync(path.join(dir, "source.webp"), source, { mode: 0o600 });
      return (await renderDerivativeInConfinedWorker(launcher!, { kind: "instagram", inputPath: path.join(dir, "source.webp"), recipe: "instagram-v1", outDir: dir }, dir)).bytes; };
    const [a, b] = [await render(), await render()];
    expect(sha256(a)).toBe(sha256(b));
  });
});
