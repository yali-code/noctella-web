/**
 * FAZ A #463 (F3 / F4): the inactive publication-recovery policy, plus disposable SQLite/PostgreSQL evidence that the
 * 0040 schema already retains the per-generation seals F3 provenance needs. No production wiring, no customer data.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sql, type SQL } from "drizzle-orm";
import { ProductStatus, ProductType } from "@noctella/shared";

const { root } = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "noctella-f3-provenance-"));
  Object.assign(process.env, { PRODUCT_PHOTO_DISK_STAGING_ENABLED: "true", PHOTO_OWNERSHIP_FENCING_ENABLED: "true", PRODUCT_PHOTO_DIR: join(root, "photos") });
  return { root };
});

import { createTestDb } from "./testDb";
import { createPostgresTestDb, postgresTestConfigured } from "./postgresTestDb";
import { fileProof, photoOperationPrivateRoot } from "../src/services/photoOperationAuthority";
import { uploadFencedProductPhoto } from "../src/services/w2FencedProductPhotoOwner";
import { digestW2StagedInput } from "../src/services/w2StagedInputDigest";
import { assertSameCanonicalRoot, classifyExistingCanonical, classifyPhotoOperationFailure, instagramErrorFor } from "../src/services/photoPublicationRecoveryPolicy";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
afterAll(async () => { await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
it.runIf(process.env.W2_LIVE_REQUIRE_POSTGRES === "1")("PostgreSQL acceptance is configured", () => { expect(postgresTestConfigured).toBe(true); });

const id = (sha: string, dev: string, ino: string) => ({ sha256: sha, dev, ino });

describe("F3 classifyExistingCanonical", () => {
  const seal = id("a".repeat(64), "1", "300"), prior = id("a".repeat(64), "1", "200");
  const live = (s: ReturnType<typeof id>) => ({ seal: s, live: { dev: s.dev, ino: s.ino } });
  const gone = (s: ReturnType<typeof id>) => ({ seal: s, live: null });
  it("adopts only this operation's own live inode with the current seal's bytes", () => {
    expect(classifyExistingCanonical(seal, seal, [live(prior), live(seal)])).toBe("ADOPT_OWN_GENERATION"); // just linked
    expect(classifyExistingCanonical(prior, seal, [live(prior), gone(seal)])).toBe("ADOPT_OWN_GENERATION"); // earlier generation's publication
  });
  it("never adopts equal bytes from a foreign inode (or another device with the same inode number)", () => {
    expect(classifyExistingCanonical(id("a".repeat(64), "1", "999"), seal, [live(prior), live(seal)])).toBe("REVIEW_FOREIGN_SAME_BYTES");
    expect(classifyExistingCanonical(id("a".repeat(64), "2", "200"), seal, [live(prior), live(seal)])).toBe("REVIEW_FOREIGN_SAME_BYTES");
  });
  it("a recorded inode number whose private name is gone is not proof: the number may have been reused (ext4)", () => {
    // The committing generation's private names are unlinked after commit; an unrelated same-bytes file can then
    // receive the very same inode number. Without liveness this was misclassified as ADOPT_OWN_GENERATION.
    expect(classifyExistingCanonical(seal, seal, [live(prior), gone(seal)])).toBe("REVIEW_FOREIGN_SAME_BYTES");
    expect(classifyExistingCanonical(prior, seal, [gone(prior), gone(seal)])).toBe("REVIEW_FOREIGN_SAME_BYTES");
  });
  it("a private name that now holds a different inode is not proof either", () => {
    expect(classifyExistingCanonical(prior, seal, [{ seal: prior, live: { dev: "1", ino: "201" } }, live(seal)])).toBe("REVIEW_FOREIGN_SAME_BYTES");
  });
  it("reviews different bytes, distinguishing an own earlier generation (non-deterministic render) from foreign", () => {
    const olderRender = id("b".repeat(64), "1", "200");
    expect(classifyExistingCanonical(olderRender, seal, [live(olderRender), live(seal)])).toBe("REVIEW_OWN_GENERATION_DIFFERENT_BYTES");
    expect(classifyExistingCanonical(id("c".repeat(64), "1", "777"), seal, [live(prior), live(seal)])).toBe("REVIEW_DIFFERENT_BYTES");
  });
  it("an inode recorded with different bytes is not proof of ownership of the current bytes", () => {
    expect(classifyExistingCanonical(id("a".repeat(64), "1", "200"), seal, [live(id("b".repeat(64), "1", "200"))])).toBe("REVIEW_FOREIGN_SAME_BYTES");
  });
});

describe("F4 classifyPhotoOperationFailure", () => {
  const sys = (code: string) => Object.assign(new Error(code), { code });
  it.each(["EIO", "ENOSPC", "EDQUOT", "EMFILE", "ENFILE", "EAGAIN", "EBUSY", "ETIMEDOUT"])("storage %s is retryable, never invalid media", (code) => {
    expect(classifyPhotoOperationFailure("storage", sys(code))).toBe("RETRYABLE");
    expect(instagramErrorFor(classifyPhotoOperationFailure("storage", sys(code)))).toEqual({ kind: "processing", retryable: true });
  });
  it.each(["EXDEV", "EACCES", "EPERM", "EROFS", "ELOOP"])("storage %s is a configuration fault (fail closed, not invalid media)", (code) => {
    expect(classifyPhotoOperationFailure("storage", sys(code))).toBe("CONFIGURATION");
  });
  it("missing ownership schema is configuration on SQLite and PostgreSQL", () => {
    expect(classifyPhotoOperationFailure("database", new Error("no such table: photo_derivative_operations"))).toBe("CONFIGURATION");
    expect(classifyPhotoOperationFailure("database", Object.assign(new Error('relation "photo_derivative_operations" does not exist'), { code: "42P01" }))).toBe("CONFIGURATION");
  });
  it("database connection, shutdown, serialization and SQLite busy are retryable", () => {
    for (const code of ["08006", "08001", "57P01", "40001", "40P01"]) expect(classifyPhotoOperationFailure("database", Object.assign(new Error("x"), { code }))).toBe("RETRYABLE");
    expect(classifyPhotoOperationFailure("database", Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }))).toBe("RETRYABLE");
  });
  it("lease/claim outcomes: in progress and fence lost retry; review and conflict go to operators", () => {
    for (const code of ["PHOTO_OPERATION_IN_PROGRESS", "PHOTO_OPERATION_FENCE_LOST", "W11_OPERATION_IN_PROGRESS", "W11_OPERATION_FENCE_LOST"]) expect(classifyPhotoOperationFailure("ownership", { code })).toBe("RETRYABLE");
    for (const code of ["PHOTO_OPERATION_REVIEW", "PHOTO_OPERATION_CONFLICT", "PHOTO_UPLOAD_IDEMPOTENCY_CONFLICT", "W11_OPERATION_REVIEW", "W11_OPERATION_CONFLICT"]) {
      expect(classifyPhotoOperationFailure("ownership", { code })).toBe("OPERATOR_REVIEW");
      expect(instagramErrorFor("OPERATOR_REVIEW")).toEqual({ kind: "processing", retryable: false });
    }
  });
  it("driver mismatch and canonical root mismatch are configuration faults", () => {
    expect(classifyPhotoOperationFailure("database", new Error("UNSUPPORTED_PHOTO_OWNERSHIP_DRIVER:mysql"))).toBe("CONFIGURATION");
    expect(classifyPhotoOperationFailure("database", new Error("PHOTO_OWNERSHIP_DRIVER_MISMATCH: x"))).toBe("CONFIGURATION");
    expect(() => assertSameCanonicalRoot("/a/photos", "/b/photos", path.resolve)).toThrow("PHOTO_CANONICAL_ROOT_MISMATCH");
    expect(() => assertSameCanonicalRoot("/a/photos/", "/a/photos", path.resolve)).not.toThrow();
    let mismatch: unknown; try { assertSameCanonicalRoot("/a", "/b", path.resolve); } catch (e) { mismatch = e; }
    expect(classifyPhotoOperationFailure("storage", mismatch)).toBe("CONFIGURATION");
  });
  it("only the caller's source can make media invalid; unknown errors fail closed for operators, not as invalid media", () => {
    expect(classifyPhotoOperationFailure("source", sys("ENOENT"))).toBe("INVALID_INPUT");
    expect(instagramErrorFor("INVALID_INPUT")).toEqual({ kind: "invalid_media", retryable: false });
    expect(classifyPhotoOperationFailure("storage", sys("ENOENT"))).toBe("OPERATOR_REVIEW");
    expect(classifyPhotoOperationFailure("storage", new TypeError("unexpected"))).toBe("OPERATOR_REVIEW");
  });
});

type Driver = "sqlite" | "postgres";
describe.each([["sqlite", true], ["postgres", postgresTestConfigured]] as Array<[Driver, boolean]>)("F3 provenance data on real 0040 (%s)", (driver, enabled) => {
  let db: any, close: () => Promise<void> = async () => {}, categoryId: string;
  const savedDriver = process.env.DATABASE_DRIVER, savedUrl = process.env.DATABASE_URL;
  const q = async (statement: SQL): Promise<any[]> => (driver === "sqlite" ? db.all(statement) : (await db.execute(statement)).rows);

  beforeAll(async () => {
    if (!enabled) return;
    if (driver === "postgres") {
      process.env.DATABASE_DRIVER = "postgres";
      process.env.DATABASE_URL = process.env.POSTGRES_TEST_DATABASE_URL;
      const harness = await createPostgresTestDb("0041_photo_w2_upload_intents.sql");
      db = harness.db; close = () => harness.close();
    } else { delete process.env.DATABASE_DRIVER; db = createTestDb(); }
    categoryId = randomUUID();
    await q(sql`INSERT INTO categories (id, name, slug) VALUES (${categoryId}, ${"F3 " + driver}, ${"f3-" + categoryId}) RETURNING id`);
  });
  afterAll(async () => {
    await close();
    if (savedDriver === undefined) delete process.env.DATABASE_DRIVER; else process.env.DATABASE_DRIVER = savedDriver;
    if (savedUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedUrl;
  });

  it.skipIf(!enabled)("after a crash after publication and a reclaim, generation 1's sealed inode proves the canonical file is the operation's own; a same-bytes copy is foreign", async () => {
    const productId = randomUUID();
    await q(sql`INSERT INTO products (id, sku, title, slug, type, status, category_id) VALUES (${productId}, ${"F3-" + productId}, 'Synthetic', ${"f3-" + productId}, ${ProductType.UniqueItem}, ${ProductStatus.Draft}, ${categoryId}) RETURNING id`);
    const workDir = await mkdtemp(path.join(os.tmpdir(), "noctella-f3-input-"));
    try {
      const bytes = await sharp({ create: { width: 120, height: 80, channels: 3, background: { r: 30, g: 140, b: 90 } } }).jpeg().toBuffer();
      await writeFile(path.join(workDir, "input"), bytes);
      const file = { path: path.join(workDir, "input"), workDir, size: bytes.length, mimetype: "image/jpeg", signal: new AbortController().signal };
      const token = `f3-${driver}-${randomUUID().slice(0, 12)}`;
      const upload = async (hooks?: any) => uploadFencedProductPhoto(db, { productId, actorId: "actor-1", operationToken: token, sha256: await digestW2StagedInput(file, 10 * 1024 * 1024), altText: "", file }, { driver, hooks });
      await expect(upload({ afterPublish: () => { throw new Error("crash after publication"); } })).rejects.toThrow("crash");
      await q(sql`UPDATE photo_operations SET lease_until_ms = 0 WHERE subject_id = ${token} AND state IN ('preparing', 'sealed') RETURNING id`);
      await upload(); // generation 2 reclaims, re-seals a new private inode, finds the key (EEXIST) and commits

      const [op] = await q(sql`SELECT id, generation, state, main_key, seal_id FROM photo_operations WHERE subject_id = ${token}`);
      expect([op.state, Number(op.generation)]).toEqual(["committed", 2]);
      const seals = (await q(sql`SELECT generation, id, main_sha256, main_dev, main_ino FROM photo_operation_artifacts WHERE operation_id = ${op.id} ORDER BY generation`))
        .map((r) => ({ generation: Number(r.generation), sealId: r.id, ...id(r.main_sha256, r.main_dev, r.main_ino) }));
      expect(seals.map((s) => s.generation)).toEqual([1, 2]); // reclaim keeps the earlier generation's seal
      const current = seals.find((s) => s.sealId === op.seal_id)!;
      const canonical = await fileProof(path.join(root, "photos", op.main_key));
      expect(canonical.ino).toBe(seals[0].ino); // the canonical name is generation 1's inode, not the current seal's
      expect(canonical.ino).not.toBe(current.ino);
      // Each generation's private name, as the authority would lstat it at publication time.
      const generations = await Promise.all(seals.map(async (s) => {
        const info = await lstat(path.join(photoOperationPrivateRoot(path.join(root, "photos")), op.id, String(s.generation), "main.webp")).catch(() => null);
        return { seal: s, live: info ? { dev: String(info.dev), ino: String(info.ino) } : null };
      }));
      expect(generations[0].live).toEqual({ dev: seals[0].dev, ino: seals[0].ino }); // crashed generation 1 keeps its private name
      expect(generations[1].live).toBeNull(); // committing generation 2's private names were unlinked: its inode number is free for reuse
      expect(classifyExistingCanonical(canonical, current, generations)).toBe("ADOPT_OWN_GENERATION");

      const foreignCopy = path.join(workDir, "same-bytes-copy.webp"); // outside the canonical root
      await copyFile(path.join(root, "photos", op.main_key), foreignCopy);
      const foreign = await fileProof(foreignCopy);
      expect(foreign.sha256).toBe(canonical.sha256);
      expect(foreign.ino).not.toBe(canonical.ino);
      // On ext4 the copy can receive generation 2's freed inode number (the CI failure on d8c4ddf); it must still be foreign.
      expect(classifyExistingCanonical(foreign, current, generations)).toBe("REVIEW_FOREIGN_SAME_BYTES");
      expect(classifyExistingCanonical({ ...foreign, dev: current.dev, ino: current.ino }, current, generations)).toBe("REVIEW_FOREIGN_SAME_BYTES");
      expect((await lstat(path.join(root, "photos", op.main_key))).ino.toString()).toBe(canonical.ino); // nothing replaced
    } finally { await rm(workDir, { recursive: true, force: true }); }
  });
});
