/**
 * P5 admission decision (runtime): instagramDerivativeRecipe.ts keeps main's admission-free recipe, so every production
 * caller must hold image admission. The recipe is wrapped here with the real assertImageOperationOwned(): any render
 * outside admission fails. Covers protected-mode and fencing-OFF preparation through mediaPreparation and the confined
 * worker's `instagram` job (run in-process), and capacity exhaustion: retryable `processing`, no render started.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";

const { root, renders } = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "noctella-ig-admission-"));
  Object.assign(process.env, {
    NODE_ENV: "test", PRODUCT_PHOTO_DISK_STAGING_ENABLED: "true", PRODUCT_PHOTO_DIR: join(root, "photos"), AI_INTAKE_PHOTO_DIR: join(root, "intake"),
    INSTAGRAM_MEDIA_ALLOWED_HOSTS: "media.example.test",
  });
  delete process.env.PHOTO_PREPARATION_CONFINEMENT; // in-process (unprotected) rendering on this platform
  return { root, renders: { owned: 0 } };
});
vi.mock("../src/integrations/instagram/instagramDerivativeRecipe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/integrations/instagram/instagramDerivativeRecipe")>();
  const { assertImageOperationOwned } = await import("../src/services/photoUploadAdmission");
  return {
    ...actual,
    renderInstagramDerivative: async (...args: Parameters<typeof actual.renderInstagramDerivative>) => {
      assertImageOperationOwned(); // throws unless the caller holds image admission
      renders.owned++;
      return actual.renderInstagramDerivative(...args);
    },
  };
});

import { InstagramClientError } from "../src/integrations/instagram/types";
import { instagramDerivativeRoot, prepareInstagramImageAsset } from "../src/integrations/instagram/mediaPreparation";
import { runImageOperation } from "../src/services/photoUploadAdmission";

const canonical = path.join(root, "photos");
const photoUrl = "/images/product-photos/prod-1-photo-1.webp";
const listing = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
const prepare = (recipe: "instagram-v1" | "instagram-portrait-v1" = "instagram-v1") =>
  prepareInstagramImageAsset({ url: photoUrl }, "https://media.example.test", process.env, canonical, recipe);

beforeAll(async () => {
  fs.mkdirSync(canonical, { recursive: true });
  await sharp({ create: { width: 320, height: 240, channels: 3, background: "#305080" } }).webp().toFile(path.join(canonical, "prod-1-photo-1.webp"));
});
afterAll(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });

describe("Instagram recipe runs only inside image admission", () => {
  it("protected mode (fencing ON): preparation renders under admission", async () => {
    vi.stubEnv("PHOTO_OWNERSHIP_FENCING_ENABLED", "true");
    const before = renders.owned;
    const prepared = await prepare();
    expect(renders.owned).toBe(before + 1);
    expect(prepared.outputSha256).toMatch(/^[0-9a-f]{64}$/);
    vi.unstubAllEnvs();
  });

  it("fencing OFF: preparation renders under admission (unchanged path)", async () => {
    vi.stubEnv("PHOTO_OWNERSHIP_FENCING_ENABLED", "false");
    const before = renders.owned;
    const prepared = await prepare("instagram-portrait-v1");
    expect(renders.owned).toBe(before + 1);
    expect(prepared.outputSha256).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it.each(["true", "false"])("capacity exhausted (fencing %s): retryable processing, no render started, nothing written", async (fencing) => {
    vi.stubEnv("PHOTO_OWNERSHIP_FENCING_ENABLED", fencing);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // Occupy the single active slot and both waiter slots of the shared admission controller.
    const holders = [runImageOperation(() => gate), runImageOperation(() => gate), runImageOperation(() => gate)];
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const before = renders.owned, stores = [listing(canonical), listing(instagramDerivativeRoot(canonical))];
      const error = await prepare().catch((e) => e);
      expect(error).toBeInstanceOf(InstagramClientError);
      expect([error.kind, error.retryable]).toEqual(["processing", true]);
      expect(renders.owned).toBe(before);
      expect([listing(canonical), listing(instagramDerivativeRoot(canonical))]).toEqual(stores);
    } finally { release(); await Promise.allSettled(holders); vi.unstubAllEnvs(); }
  });

  it("the confined worker's instagram job renders under admission", async () => {
    const outDir = fs.mkdtempSync(path.join(root, "job-"));
    const inputPath = path.join(outDir, "source.webp");
    fs.copyFileSync(path.join(canonical, "prod-1-photo-1.webp"), inputPath);
    const lines: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => { lines.push(String(chunk)); return true; });
    const before = renders.owned;
    try {
      process.env.PHOTO_PREPARATION_JOB = Buffer.from(JSON.stringify({ kind: "instagram", inputPath, recipe: "instagram-v1", outDir })).toString("base64");
      await import("../src/workers/photoPreparationWorker");
      for (let i = 0; i < 200 && !lines.some((l) => l.startsWith("{")); i++) await new Promise((resolve) => setTimeout(resolve, 25));
    } finally { write.mockRestore(); delete process.env.PHOTO_PREPARATION_JOB; }
    const result = JSON.parse(lines.find((l) => l.startsWith("{"))!);
    expect(result).toEqual({ ok: true, derivative: path.join(outDir, "derivative.jpg") });
    expect(renders.owned).toBe(before + 1);
    expect(fs.statSync(result.derivative).size).toBeGreaterThan(0);
  });
});
