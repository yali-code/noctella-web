/**
 * #472 daily-use parity 4B: Instagram image preparation in protected mode (fencing ON) without W11/0042.
 * Derivatives go to the separate non-canonical, content-addressed store; the canonical product-photo root is only read;
 * rendering runs in the mandatory confined worker on Linux CI (unprotected in-process on other test platforms).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";

const { root, launcher } = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "noctella-ig-store-"));
  const launcher = process.platform === "linux" ? process.env.F2_CAPABILITY_LAUNCHER : undefined;
  Object.assign(process.env, {
    DATABASE_URL: ":memory:", PHOTO_OWNERSHIP_FENCING_ENABLED: "true", PRODUCT_PHOTO_DIR: join(root, "photos"), AI_INTAKE_PHOTO_DIR: join(root, "intake"),
    INSTAGRAM_MEDIA_ALLOWED_HOSTS: "media.example.test", MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"), MARKETPLACE_OAUTH_STATE_SECRET: "ig-store",
    ADMIN_APP_ORIGIN: "http://localhost:3001", STOREFRONT_APP_ORIGIN: "http://localhost:3000",
    ...(launcher ? { PHOTO_PREPARATION_CONFINEMENT: "required", PHOTO_PREPARATION_LAUNCHER: launcher } : {}),
  });
  delete process.env.DATABASE_DRIVER;
  return { root, launcher };
});
vi.setConfig({ testTimeout: 120_000 });

import { INSTAGRAM_DERIVATIVE_STATIC_PATH, inspectPreparedInstagramImage, instagramDerivativeRoot, prepareInstagramImageAsset } from "../src/integrations/instagram/mediaPreparation";

const canonical = path.join(root, "photos");
const snapshot = () => fs.readdirSync(canonical).sort().map((f) => `${f}:${fs.statSync(path.join(canonical, f)).ino}:${fs.statSync(path.join(canonical, f)).size}`);
let photoUrl = "";

it.runIf(process.env.F2_CAPABILITY_REQUIRE_LINUX === "1")("required: protected Instagram preparation runs confined", () => {
  expect(launcher).toBeTruthy();
});

beforeAll(async () => {
  fs.mkdirSync(canonical, { recursive: true });
  await sharp({ create: { width: 640, height: 480, channels: 3, background: "#305080" } }).webp().toFile(path.join(canonical, "prod-1-photo-1.webp"));
  photoUrl = "/images/product-photos/prod-1-photo-1.webp";
});
afterAll(() => { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });

describe("protected-mode Instagram derivatives", () => {
  it("prepares into the non-canonical store; the canonical root is untouched; inspection validates the record", async () => {
    const before = snapshot();
    const prepared = await prepareInstagramImageAsset({ url: photoUrl }, "https://media.example.test", process.env, canonical);
    expect(prepared.outputPath).toMatch(new RegExp(`^${INSTAGRAM_DERIVATIVE_STATIC_PATH}/instagram-v1-[0-9a-f]{64}\\.jpg$`));
    expect(prepared.url).toBe(`https://media.example.test${prepared.outputPath}`);
    const file = path.join(instagramDerivativeRoot(canonical), path.basename(prepared.outputPath));
    const meta = await sharp(file).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 1080, 1080]);
    expect(snapshot()).toEqual(before);
    expect(await inspectPreparedInstagramImage({ url: photoUrl }, prepared, canonical)).toBe(true);
    expect(fs.readdirSync(instagramDerivativeRoot(canonical)).filter((f) => f.startsWith("."))).toEqual([]); // no temp/job leftovers
  });

  it("is idempotent and collision-free: repeated and concurrent preparation produce one immutable file", async () => {
    const first = await prepareInstagramImageAsset({ url: photoUrl }, "https://media.example.test", process.env, canonical);
    const file = path.join(instagramDerivativeRoot(canonical), path.basename(first.outputPath));
    const inode = fs.statSync(file).ino;
    const all = await Promise.all([1, 2, 3].map(() => prepareInstagramImageAsset({ url: photoUrl }, "https://media.example.test", process.env, canonical)));
    expect(new Set(all.map((p) => p.outputPath))).toEqual(new Set([first.outputPath]));
    expect(fs.statSync(file).ino).toBe(inode);
    expect(fs.readdirSync(instagramDerivativeRoot(canonical)).filter((f) => f.endsWith(".jpg"))).toHaveLength(1);
  });

  it("a changed canonical source yields a new derivative name; the old record no longer validates (no stale reuse)", async () => {
    const old = await prepareInstagramImageAsset({ url: photoUrl }, "https://media.example.test", process.env, canonical);
    await sharp({ create: { width: 640, height: 480, channels: 3, background: "#805030" } }).webp().toFile(path.join(canonical, "prod-1-photo-2.webp"));
    const other = await prepareInstagramImageAsset({ url: "/images/product-photos/prod-1-photo-2.webp" }, "https://media.example.test", process.env, canonical);
    expect(other.outputPath).not.toBe(old.outputPath);
    expect(await inspectPreparedInstagramImage({ url: "/images/product-photos/prod-1-photo-2.webp" }, old, canonical)).toBe(false);
  });

  it("rejects traversal and non-canonical sources without writing", async () => {
    const before = fs.readdirSync(instagramDerivativeRoot(canonical)).sort();
    for (const url of ["/images/product-photos/../x.webp", "/images/instagram-derivatives/a.webp", "/images/product-photos/missing.webp"])
      await expect(prepareInstagramImageAsset({ url }, "https://media.example.test", process.env, canonical)).rejects.toMatchObject({ kind: "invalid_media" });
    expect(fs.readdirSync(instagramDerivativeRoot(canonical)).sort()).toEqual(before);
  });

  it("records prepared before protected mode (canonical-root outputPath) still validate", async () => {
    vi.stubEnv("PHOTO_OWNERSHIP_FENCING_ENABLED", "false");
    try {
      const legacy = await prepareInstagramImageAsset({ url: photoUrl }, "https://media.example.test", process.env, canonical);
      expect(legacy.outputPath.startsWith("/images/product-photos/instagram-v1-")).toBe(true);
      vi.stubEnv("PHOTO_OWNERSHIP_FENCING_ENABLED", "true");
      expect(await inspectPreparedInstagramImage({ url: photoUrl }, legacy, canonical)).toBe(true);
    } finally { vi.unstubAllEnvs(); }
  });

  it("the store is served at its public path (what Instagram publishing fetches); dotfiles are not served", async () => {
    const prepared = await prepareInstagramImageAsset({ url: photoUrl }, "https://media.example.test", process.env, canonical);
    const app = (await import("../src/app")).default;
    const res = await request(app).get(prepared.outputPath);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/image\/jpeg/);
    fs.writeFileSync(path.join(instagramDerivativeRoot(canonical), ".hidden"), "x");
    const hidden = await request(app).get(`${INSTAGRAM_DERIVATIVE_STATIC_PATH}/.hidden`);
    expect(hidden.status).not.toBe(200); // dotfiles (temp/job names) are never served
    expect(hidden.text).not.toBe("x");
    // In-flight confined job directories (private source copy) are not served either (nested dot segment).
    fs.mkdirSync(path.join(instagramDerivativeRoot(canonical), ".job-review"), { recursive: true });
    fs.writeFileSync(path.join(instagramDerivativeRoot(canonical), ".job-review", "source.webp"), "y");
    const nested = await request(app).get(`${INSTAGRAM_DERIVATIVE_STATIC_PATH}/.job-review/source.webp`);
    expect(nested.status).not.toBe(200);
    expect(nested.text).not.toBe("y");
  });
});
