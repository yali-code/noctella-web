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

  it("denies writes and hard links into every protected root; only its own job directory is writable", async () => {
    const dir = jobDir();
    let error: any;
    await renderDerivativeInConfinedWorker(launcher!, { kind: "instagram", inputPath: path.join(dir, "source.webp"), recipe: "instagram-v1", outDir: dir, probe: protectedRoots } as any, dir,
      { workerScript: path.join(__dirname, "fixtures", "instagramDerivativeEvilWorker.ts") }).catch((e) => { error = e; });
    expect(error?.code).toBe("EVIL_REPORT");
    const report = JSON.parse(error.message);
    expect(report.ownWrite).toBe("WRITTEN");
    for (const label of Object.keys(protectedRoots)) for (const kind of ["Write", "Link"])
      expect(["EACCES", "EPERM", "EXDEV"], `${label}${kind}`).toContain(report[`${label}${kind}`]);
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
