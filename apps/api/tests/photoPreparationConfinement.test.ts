/**
 * Stage 5 F2 (#472) confined preparation: configuration fails closed everywhere; on Linux with the real launcher the
 * W2/W4 preparation runs in a Landlock-confined worker that cannot write the canonical root or the database, sees no
 * database URL, and must report enforcement; the owners then seal, publish and commit exactly as in-process.
 */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql, type SQL } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProductStatus, ProductType } from "@noctella/shared";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema.sqlite";
import { assertPreparationConfinementReady, photoPreparationConfinementConfig, prepareInConfinedWorker, withPreparationJobDir } from "../src/services/photoPreparationConfinement";
import { uploadFencedProductPhoto } from "../src/services/w2FencedProductPhotoOwner";
import { buildFencedAiIntakePhotoFinalizationManifest } from "../src/services/w4FencedFinalizationOwner";
import { digestW2StagedInput } from "../src/services/w2StagedInputDigest";
import { createPostgresTestDb, postgresTestConfigured } from "./postgresTestDb";
import { spawn } from "node:child_process";
import { publishVerifiedCopy, type CopyRecord } from "../src/services/photoCopyPublisher";

const launcher = process.env.F2_CAPABILITY_LAUNCHER;
const native = process.platform === "linux" && !!launcher;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "noctella-confined-prep-"));
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

it.runIf(process.env.F2_CAPABILITY_REQUIRE_LINUX === "1")("required Linux execution of the confined-preparation suite", () => {
  expect(native).toBe(true); expect(postgresTestConfigured).toBe(true);
});

describe("confinement configuration fails closed", () => {
  it("protected mode requires confinement: unset is NOT READY outside test/development; malformed values or a missing launcher are never ignored", () => {
    for (const NODE_ENV of ["test", "development"]) {
      expect(photoPreparationConfinementConfig({ NODE_ENV })).toEqual({ mode: "in-process-unprotected" });
      expect(photoPreparationConfinementConfig({ NODE_ENV, PHOTO_PREPARATION_CONFINEMENT: "" })).toEqual({ mode: "in-process-unprotected" });
    }
    for (const env of [{}, { NODE_ENV: "production" }, { NODE_ENV: "staging" }, { PHOTO_PREPARATION_CONFINEMENT: "true" }, { PHOTO_PREPARATION_CONFINEMENT: "required" }, { PHOTO_PREPARATION_CONFINEMENT: "required", PHOTO_PREPARATION_LAUNCHER: "relative/launcher" },
      { PHOTO_PREPARATION_CONFINEMENT: "required", PHOTO_PREPARATION_LAUNCHER: path.join(root, "missing-launcher") }]) {
      expect(photoPreparationConfinementConfig(env).mode).toBe("invalid");
      expect(() => assertPreparationConfinementReady(env)).toThrow(expect.objectContaining({ status: 503, code: "PHOTO_PUBLICATION_NOT_READY" }));
    }
    expect(() => assertPreparationConfinementReady({ NODE_ENV: "test" })).not.toThrow();
  });
  it("protected mode outside test/development refuses W2 and W4 before any work when preparation is not confined", async () => {
    const saved = { env: process.env.NODE_ENV, mode: process.env.PHOTO_PREPARATION_CONFINEMENT };
    process.env.NODE_ENV = "production"; delete process.env.PHOTO_PREPARATION_CONFINEMENT;
    try {
      const file = { path: path.join(root, "never-read"), workDir: root, size: 10, mimetype: "image/jpeg", signal: new AbortController().signal };
      await expect(uploadFencedProductPhoto({} as any, { productId: "p", actorId: "actor-1", operationToken: "not-reached-0000001", sha256: "a".repeat(64), altText: "", file } as any, { driver: "sqlite", canonicalRoot: path.join(root, "never") }))
        .rejects.toMatchObject({ status: 503, code: "PHOTO_PUBLICATION_NOT_READY" });
      await expect(buildFencedAiIntakePhotoFinalizationManifest({} as any, async () => { throw new Error("never read"); }, [{ id: "s1", storageKey: "a.jpg" }] as any, "p", undefined, { driver: "sqlite", canonicalRoot: path.join(root, "never") }))
        .rejects.toMatchObject({ status: 503, code: "PHOTO_PUBLICATION_NOT_READY" });
      expect(fs.existsSync(path.join(root, "never"))).toBe(false);
    } finally {
      if (saved.env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.env;
      if (saved.mode === undefined) delete process.env.PHOTO_PREPARATION_CONFINEMENT; else process.env.PHOTO_PREPARATION_CONFINEMENT = saved.mode;
    }
  });
  it.runIf(native)("Linux: an executable launcher makes it confined", () => {
    expect(photoPreparationConfinementConfig({ PHOTO_PREPARATION_CONFINEMENT: "required", PHOTO_PREPARATION_LAUNCHER: launcher })).toEqual({ mode: "confined", launcher });
  });
});

describe.runIf(native)("confined worker on Linux (real launcher)", () => {
  let input: Buffer;
  beforeAll(async () => { input = await sharp({ create: { width: 160, height: 100, channels: 3, background: "#406080" } }).jpeg().toBuffer(); });
  const generation = () => { const dir = fs.mkdtempSync(path.join(root, "op-")); const gen = path.join(dir, "1"); fs.mkdirSync(gen, { mode: 0o700 }); return gen; };

  it("runs the W4 recipe confined, reports enforcement, and has exited before returning", async () => {
    const outDir = generation();
    const result = await withPreparationJobDir(outDir, async (jobDir) => {
      fs.writeFileSync(path.join(jobDir, "source"), input);
      return prepareInConfinedWorker(launcher!, { kind: "w4", inputPath: path.join(jobDir, "source"), size: input.length, mimetype: "image/jpeg", outDir }, jobDir);
    });
    expect(result.enforced).toMatch(/^abi=\d+$/);
    expect(Number(result.enforced.slice(4))).toBeGreaterThanOrEqual(3);
    expect([result.main, result.thumb]).toEqual([path.join(outDir, "main.webp"), path.join(outDir, "thumb.webp")]);
    expect(fs.statSync(result.main).size).toBeGreaterThan(0);
    expect(fs.existsSync(outDir + ".job")).toBe(false); // job directory removed after the worker exited
  });

  it("a hostile worker cannot write the canonical root or the database directory, cannot alias out, and sees no database URL", async () => {
    const outDir = generation(), canonicalDir = fs.mkdtempSync(path.join(root, "canonical-")), databaseDir = fs.mkdtempSync(path.join(root, "db-"));
    const ownFile = path.join(outDir, "own-source"); fs.writeFileSync(ownFile, "x");
    const saved = process.env.DATABASE_URL; process.env.DATABASE_URL = path.join(databaseDir, "api.sqlite");
    let error: any;
    try {
      await withPreparationJobDir(outDir, (jobDir) => prepareInConfinedWorker(launcher!, { kind: "w4", inputPath: ownFile, size: 1, mimetype: "image/jpeg", outDir, probe: { canonicalDir, databaseDir, ownFile } } as any, jobDir,
        { workerScript: path.join(__dirname, "fixtures", "photoPreparationEvilWorker.ts") })).catch((e) => { error = e; });
    } finally { if (saved === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved; }
    expect(error?.code).toBe("EVIL_REPORT");
    const report = JSON.parse(error.message);
    for (const key of ["canonicalWrite", "canonicalLink", "databaseDirWrite", "aliasWrite"]) expect(["EACCES", "EPERM", "EXDEV"], key).toContain(report[key]);
    expect(report.ownWrite).toBe("WRITTEN");
    expect(report.databaseUrlVisible).toBe(false);
    expect(fs.readdirSync(canonicalDir)).toEqual([]); expect(fs.readdirSync(databaseDir)).toEqual([]);
  });

  /**
   * The disputed review claim: "an unconfined hostile same-UID preparer can only cause collisions/DoS". The negative
   * control shows it can tamper with published bytes and authority material directly; the same code under the
   * launcher is denied every path. Integrity against hostile preparers therefore requires the confinement boundary.
   */
  it("same-UID hostile preparer: unconfined it tampers with published bytes and reads API secrets; confined every attempt is denied", async () => {
    async function published() {
      const dir = fs.mkdtempSync(path.join(root, "attack-")), canonicalDir = path.join(dir, "photos"), stagingDir = path.join(dir, ".stage");
      fs.mkdirSync(canonicalDir); fs.writeFileSync(path.join(dir, "src"), "sealed-bytes");
      const st = fs.statSync(path.join(dir, "src"), { bigint: true });
      let rec: CopyRecord | null = null;
      const seal = { sha256: require("node:crypto").createHash("sha256").update("sealed-bytes").digest("hex"), size: 12, dev: String(st.dev), ino: String(st.ino) };
      expect((await publishVerifiedCopy({ source: path.join(dir, "src"), seal, canonicalDir, canonicalName: "k.webp", stagingDir, retainStagingLink: true },
        { read: async () => rec, record: async (c) => { rec = c; } })).kind).toBe("PUBLISHED");
      const canonicalFile = path.join(canonicalDir, "k.webp"), anchorFile = path.join(stagingDir, fs.readdirSync(stagingDir)[0]);
      const apiFd = fs.openSync(canonicalFile, "r"); // the API process holds a read descriptor to a published file
      return { dir, canonicalFile, anchorFile, apiFd, probe: { canonicalFile, anchorFile, apiPid: process.pid, apiFd } };
    }
    const fixture = path.join(__dirname, "fixtures", "photoSameUidAttacker.ts");
    // NEGATIVE CONTROL: same code, same UID, no confinement.
    const open = await published();
    try {
      const child = spawn(process.execPath, ["--import", "tsx", fixture], { cwd: path.resolve(__dirname, ".."), stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH, PHOTO_PREPARATION_JOB: Buffer.from(JSON.stringify({ probe: open.probe })).toString("base64") } });
      let out = ""; child.stdout!.on("data", (d) => { out += d; });
      await new Promise((resolve) => child.once("exit", resolve));
      const report = JSON.parse(JSON.parse(out.trim().split("\n").pop()!).message);
      expect(report).toEqual({ canonicalInPlace: "WRITTEN", stagingAnchor: "WRITTEN", apiDescriptorReopen: "WRITTEN", apiEnvironment: "READ" });
      expect(fs.readFileSync(open.canonicalFile, "utf8")).not.toBe("sealed-bytes"); // integrity NOT protected unconfined
    } finally { fs.closeSync(open.apiFd); }
    // CONFINED: the same attacker through the real launcher.
    const shut = await published();
    try {
      const outDir = path.join(shut.dir, "gen"); fs.mkdirSync(outDir, { mode: 0o700 });
      let error: any;
      await withPreparationJobDir(outDir, (jobDir) => prepareInConfinedWorker(launcher!, { kind: "w4", inputPath: shut.canonicalFile, size: 1, mimetype: "image/jpeg", outDir, probe: shut.probe } as any, jobDir,
        { workerScript: fixture })).catch((e) => { error = e; });
      expect(error?.code).toBe("ATTACK_REPORT");
      const report = JSON.parse(error.message);
      for (const key of ["canonicalInPlace", "stagingAnchor", "apiDescriptorReopen", "apiEnvironment"]) expect(["EACCES", "EPERM"], key).toContain(report[key]);
      expect(fs.readFileSync(shut.canonicalFile, "utf8")).toBe("sealed-bytes");
      expect(fs.readFileSync(shut.anchorFile, "utf8")).toBe("sealed-bytes");
    } finally { fs.closeSync(shut.apiFd); }
  });

  it("a launcher that does not confine is refused (fail closed, outputs never returned)", async () => {
    const fake = path.join(root, "fake-launcher.sh");
    fs.writeFileSync(fake, "#!/bin/sh\nwhile [ \"$1\" != \"--\" ]; do shift; done\nshift\nexec \"$@\"\n", { mode: 0o755 });
    const outDir = generation();
    await expect(withPreparationJobDir(outDir, async (jobDir) => {
      fs.writeFileSync(path.join(jobDir, "source"), input);
      return prepareInConfinedWorker(fake, { kind: "w4", inputPath: path.join(jobDir, "source"), size: input.length, mimetype: "image/jpeg", outDir }, jobDir);
    })).rejects.toMatchObject({ status: 503, code: "PHOTO_PREPARATION_UNAVAILABLE" });
  });
});

describe.each([["sqlite", true], ["postgres", postgresTestConfigured]] as const)("W2/W4 owners with PHOTO_PREPARATION_CONFINEMENT=required on %s", (driver, configured) => {
  let db: any, raw: Database.Database | undefined, close = async () => {}, productId: string, input: Buffer;
  const canonical = path.join(root, driver + "-tree", "photos");
  const q = async (s: SQL): Promise<any[]> => driver === "sqlite" ? db.all(s) : (await db.execute(s)).rows;
  const saved = { mode: process.env.PHOTO_PREPARATION_CONFINEMENT, launcher: process.env.PHOTO_PREPARATION_LAUNCHER, driver: process.env.DATABASE_DRIVER };
  const run = (name: string, fn: () => Promise<void>) => it.skipIf(!native || !configured)(name, fn);
  beforeAll(async () => {
    if (!native || !configured) return;
    fs.mkdirSync(canonical, { recursive: true });
    if (driver === "postgres") { process.env.DATABASE_DRIVER = "postgres"; const h = await createPostgresTestDb("0044_photo_publication_copies.sql"); db = h.db; close = () => h.close(); }
    else { raw = new Database(path.join(root, "confined.sqlite")); raw.pragma("foreign_keys = ON"); ensureSchema(raw); db = drizzle(raw, { schema }); close = async () => raw!.close(); }
    const category = randomUUID(); productId = randomUUID();
    await q(sql`INSERT INTO categories (id, name, slug) VALUES (${category}, 'Confined', ${"confined-" + category}) RETURNING id`);
    await q(sql`INSERT INTO products (id, sku, title, slug, type, status, category_id) VALUES (${productId}, ${"CONF-" + productId}, 'Synthetic', ${"conf-" + productId}, ${ProductType.UniqueItem}, ${ProductStatus.Draft}, ${category}) RETURNING id`);
    input = await sharp({ create: { width: 150, height: 90, channels: 3, background: "#603020" } }).jpeg().toBuffer();
    Object.assign(process.env, { PHOTO_PREPARATION_CONFINEMENT: "required", PHOTO_PREPARATION_LAUNCHER: launcher });
  });
  afterAll(async () => {
    for (const [key, value] of [["PHOTO_PREPARATION_CONFINEMENT", saved.mode], ["PHOTO_PREPARATION_LAUNCHER", saved.launcher], ["DATABASE_DRIVER", saved.driver]] as const)
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await close();
  });

  run("W2 upload: confined preparation, protected publication, exactly one committed photo", async () => {
    const workDir = fs.mkdtempSync(path.join(root, "w2-"));
    fs.writeFileSync(path.join(workDir, "input"), input);
    const file = { path: path.join(workDir, "input"), workDir, size: input.length, mimetype: "image/jpeg", signal: new AbortController().signal };
    const token = `confined-${driver}-${randomUUID().slice(0, 8)}`;
    const photo: any = await uploadFencedProductPhoto(db, { productId, actorId: "actor-1", operationToken: token, sha256: await digestW2StagedInput(file, 10 * 1024 * 1024), altText: "", file }, { driver, canonicalRoot: canonical });
    const [op] = await q(sql`SELECT id, state, main_key FROM photo_operations WHERE subject_id = ${token}`);
    expect([op.state, photo.id]).toEqual(["committed", photo.id]);
    const [copy] = await q(sql`SELECT copy_ino FROM photo_publication_copies WHERE operation_id = ${op.id} AND artifact = 'main'`);
    expect(String(fs.statSync(path.join(canonical, op.main_key), { bigint: true }).ino)).toBe(String(copy.copy_ino));
    expect(fs.readdirSync(path.join(path.dirname(canonical), ".product-photo-operations", op.id)).filter((n) => n.endsWith(".job"))).toEqual([]);
  });

  run("W4 manifest: confined preparation for every staged photo, published copies, intent-authorized fences", async () => {
    const staged = [{ id: randomUUID(), storageKey: "a.jpg" }, { id: randomUUID(), storageKey: "b.jpg" }];
    const result = await buildFencedAiIntakePhotoFinalizationManifest(db, async () => input, staged as any, productId, undefined, { driver, canonicalRoot: canonical });
    expect(result.manifest.map((e) => [e.stagedPhotoId, typeof e.fence?.intent?.token])).toEqual(staged.map((s) => [s.id, "string"]));
    // Before the finalization commits, the second link of each published copy is the publisher's staging anchor.
    for (const entry of result.manifest) expect(fs.statSync(path.join(canonical, entry.mainStorageKey), { bigint: true }).nlink).toBe(2n);
  });
});
