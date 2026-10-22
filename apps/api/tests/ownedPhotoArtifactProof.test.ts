/** Stage 5: corrected descriptor invariant in live W2/W4 shared code. REPRO explicitly retains unresolved F2. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql, type SQL } from "drizzle-orm";
const audit = vi.hoisted(() => {
  const fs = require("node:fs"), os = require("node:os"), p = require("node:path");
  const root = fs.mkdtempSync(p.join(os.tmpdir(), "noctella-stage5-proof-"));
  Object.assign(process.env, { PRODUCT_PHOTO_DIR: p.join(root, "photos"), PHOTO_OWNERSHIP_FENCING_ENABLED: "true", PRODUCT_PHOTO_DISK_STAGING_ENABLED: "true" });
  return { root, afterStat: undefined as undefined | ((file: string) => Promise<void>), afterRead: undefined as undefined | ((file: string) => Promise<void>), opened: 0, closed: 0 };
});
vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, lstat: async (...args: any[]) => { const info = await (fs.lstat as any)(...args); await audit.afterStat?.(String(args[0])); return info; },
    open: async (...args: any[]) => {
      const handle = await (fs.open as any)(...args); audit.opened++;
      const read = handle.read.bind(handle), close = handle.close.bind(handle);
      handle.read = async (...readArgs: any[]) => { const result = await read(...readArgs); await audit.afterRead?.(String(args[0])); return result; };
      handle.close = async () => { audit.closed++; return close(); }; return handle;
    } };
});
import { link, lstat, mkdir, writeFile, readFile, rename, rm, readdir, symlink, open } from "node:fs/promises";
import { ownedPhotoArtifactProof } from "../src/services/ownedPhotoArtifactProof";
import { fileProof, createGenerationDirectory, createOperation, claimExistingOperation, inOwnershipTransaction, sealPreparedArtifacts, publishSealedArtifacts, type OwnedOperation } from "../src/services/photoOperationAuthority";
import { ensureSchema } from "../src/db/migrate";
import { createPostgresTestDb, postgresTestConfigured } from "./postgresTestDb";
vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });
let dir: string;
beforeEach(async () => { dir = path.join(audit.root, randomUUID()); await mkdir(dir); audit.opened = 0; audit.closed = 0; });
afterEach(() => { audit.afterStat = undefined; audit.afterRead = undefined; });
afterAll(async () => {
  const resolved = path.resolve(audit.root);
  if (!path.basename(resolved).startsWith("noctella-stage5-proof-") || !resolved.startsWith(path.resolve(require("node:os").tmpdir()) + path.sep)) throw new Error("UNSAFE_CLEANUP");
  await rm(resolved, { recursive: true, force: true });
});
it.runIf(process.env.W2_LIVE_REQUIRE_POSTGRES === "1")("required PostgreSQL descriptor acceptance is configured", () => expect(postgresTestConfigured).toBe(true));
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
async function replace(file: string, bytes = "replacement") { await rename(file, file + ".retained"); await writeFile(file, bytes, { flag: "wx" }); }
describe("SECURITY INVARIANT PASSED: W2/W4 descriptor proof", () => {
  it("hash, exact bytes and bigint identity describe one regular file across multiple chunks", async () => {
    const file = path.join(dir, "file"), data = Buffer.alloc(150_001, 7); await writeFile(file, data);
    const expected = await lstat(file, { bigint: true });
    expect(await ownedPhotoArtifactProof(file)).toEqual({ sha256: sha(data), bytes: data.length, ino: String(expected.ino), dev: String(expected.dev) });
    expect(audit.opened).toBe(1); expect(audit.closed).toBe(1);
  });
  it("rejects same-byte replacement between lstat and descriptor open", async () => {
    const file = path.join(dir, "file"); await writeFile(file, "original");
    audit.afterStat = async name => { if (name !== file) return; audit.afterStat = undefined; await replace(file, "original"); };
    await expect(ownedPhotoArtifactProof(file)).rejects.toThrow("PHOTO_ARTIFACT_CHANGED");
    expect(audit.opened).toBe(1); expect(audit.closed).toBe(1);
  });
  it("rejects pathname replacement while reading and closes the opened descriptor", async () => {
    const file = path.join(dir, "file"); await writeFile(file, "original");
    audit.afterRead = async name => { if (name !== file) return; audit.afterRead = undefined; await replace(file); };
    await expect(ownedPhotoArtifactProof(file)).rejects.toThrow("PHOTO_ARTIFACT_CHANGED"); expect(audit.closed).toBe(1);
  });
  it("rejects in-place growth instead of reading unbounded appended data", async () => {
    const file = path.join(dir, "file"); await writeFile(file, "original");
    audit.afterRead = async name => { if (name !== file) return; audit.afterRead = undefined; await writeFile(file, "longer replacement"); };
    await expect(ownedPhotoArtifactProof(file)).rejects.toThrow("PHOTO_ARTIFACT_CHANGED"); expect(audit.closed).toBe(1);
  });
  it("rejects a same-size mutation with a changed timestamp", async () => {
    const file = path.join(dir, "file"); await writeFile(file, "original");
    audit.afterRead = async name => { if (name !== file) return; audit.afterRead = undefined; const h = await open(file, "r+"); try { await h.writeFile("modified"); await h.utimes(new Date(1000), new Date(2000)); } finally { await h.close(); } };
    await expect(ownedPhotoArtifactProof(file)).rejects.toThrow("PHOTO_ARTIFACT_CHANGED"); expect(audit.opened).toBe(audit.closed);
  });
  it("propagates a read EIO and closes the descriptor without relabeling the failure", async () => {
    const file = path.join(dir, "file"); await writeFile(file, "original");
    audit.afterRead = async () => { audit.afterRead = undefined; throw Object.assign(new Error("synthetic EIO"), { code: "EIO" }); };
    await expect(ownedPhotoArtifactProof(file)).rejects.toMatchObject({ code: "EIO" }); expect(audit.closed).toBe(1);
  });
  it("empty regular files have an exact empty proof", async () => {
    const file = path.join(dir, "empty"); await writeFile(file, ""); expect(await ownedPhotoArtifactProof(file)).toMatchObject({ bytes: 0, sha256: sha("") });
  });
  it.runIf(process.platform !== "win32")("refuses final symlinks and a regular-file-to-FIFO open race", async () => {
    const file = path.join(dir, "file"); await writeFile(file, "original"); await symlink(file, path.join(dir, "alias"));
    await expect(ownedPhotoArtifactProof(path.join(dir, "alias"))).rejects.toThrow("PHOTO_ARTIFACT_NOT_REGULAR");
    audit.afterStat = async name => { if (name !== file) return; audit.afterStat = undefined; await rename(file, file + ".retained"); await symlink(file + ".retained", file); };
    await expect(ownedPhotoArtifactProof(file)).rejects.toMatchObject({ code: "ELOOP" });
    await rm(file); await rename(file + ".retained", file);
    audit.afterStat = async name => { if (name !== file) return; audit.afterStat = undefined; await rename(file, file + ".retained"); expect(spawnSync("mkfifo", [file]).status).toBe(0); };
    await expect(ownedPhotoArtifactProof(file)).rejects.toThrow("PHOTO_ARTIFACT_CHANGED"); expect(audit.opened).toBe(audit.closed);
  });
});
it("VULNERABILITY REPRODUCED: W11's unchanged legacy helper still mixes a path swap", async () => {
  const file = path.join(dir, "file"); await writeFile(file, "A"); const before = await lstat(file);
  audit.afterStat = async name => { if (name !== file) return; audit.afterStat = undefined; await replace(file, "replacement-B"); };
  expect(await fileProof(file)).toMatchObject({ bytes: 1, ino: String(before.ino), sha256: sha("replacement-B") });
});

describe.each([["sqlite", true], ["postgres", postgresTestConfigured]] as const)("live W2/W4 shared authority on %s", (driver, enabled) => {
  let db: any, raw: Database.Database | undefined, close = async () => {};
  const q = async (statement: SQL): Promise<any[]> => driver === "sqlite" ? db.all(statement) : (await db.execute(statement)).rows;
  const tx = <T,>(steps: () => Generator<SQL, T, any[]>) => inOwnershipTransaction(db, driver, steps);
  beforeAll(async () => {
    if (!enabled) return;
    if (driver === "postgres") { const h = await createPostgresTestDb("0041_photo_w2_upload_intents.sql"); db = h.db; close = () => h.close(); }
    else { raw = new Database(":memory:"); raw.pragma("foreign_keys=ON"); ensureSchema(raw); db = drizzle(raw); close = async () => { raw!.close(); }; }
  });
  afterAll(async () => { await close(); });
  describe.each(["product_upload", "ai_finalize"] as const)("%s", kind => {
    async function fixture() {
      const id = randomUUID();
      const op = await tx(() => createOperation(driver, { kind, subjectType: "stage5-test", subjectId: id, targetPhotoId: id, mainKey: id + ".webp", thumbKey: id + "-thumb.webp", inputSha256: sha("synthetic") }, 300_000));
      const generationDir = await createGenerationDirectory(op, path.join(dir, "canonical"));
      const files = { main: path.join(generationDir, "main.webp"), thumb: path.join(generationDir, "thumb.webp") };
      await writeFile(files.main, "synthetic-main"); await writeFile(files.thumb, "synthetic-thumb");
      return { op, files };
    }
    it.skipIf(!enabled)("SECURITY INVARIANT PASSED: sealing uses descriptor proof and refuses swapped inode before DB seal", async () => {
      const { op, files } = await fixture();
      audit.afterStat = async name => { if (name !== files.main) return; audit.afterStat = undefined; await replace(files.main, "synthetic-main"); };
      await expect(sealPreparedArtifacts(db, driver, op, files)).rejects.toThrow("PHOTO_ARTIFACT_CHANGED");
      expect((await q(sql`SELECT state FROM photo_operations WHERE id=${op.id}`))[0].state).toBe("preparing");
      expect(await q(sql`SELECT id FROM photo_operation_artifacts WHERE operation_id=${op.id}`)).toHaveLength(0);
    });
    it.skipIf(!enabled)("SECURITY INVARIANT PASSED: publication reproof rejects swapped inode before any canonical link", async () => {
      const { op, files } = await fixture(), seal = await sealPreparedArtifacts(db, driver, op, files); expect(seal).not.toBeNull();
      audit.afterStat = async name => { if (name !== files.main) return; audit.afterStat = undefined; await replace(files.main, "synthetic-main"); };
      const canonical = path.join(dir, "canonical");
      await expect(publishSealedArtifacts(db, driver, op, files, seal!, canonical)).rejects.toThrow("PHOTO_ARTIFACT_CHANGED");
      await expect(lstat(canonical)).rejects.toMatchObject({ code: "ENOENT" });
    });
    it.skipIf(!enabled)("SECURITY INVARIANT PASSED: post-link verification rejects a swapped canonical inode and retains evidence", async () => {
      const { op, files } = await fixture(), seal = await sealPreparedArtifacts(db, driver, op, files), canonical = path.join(dir, "canonical");
      const destination = path.join(canonical, op.mainKey);
      audit.afterStat = async name => { if (name !== destination) return; audit.afterStat = undefined; await replace(destination, "foreign-after-link"); };
      await expect(publishSealedArtifacts(db, driver, op, files, seal!, canonical)).rejects.toThrow("PHOTO_ARTIFACT_CHANGED");
      expect(await readFile(destination, "utf8")).toBe("foreign-after-link"); expect(await readFile(destination + ".retained", "utf8")).toBe("synthetic-main");
    });
    it.skipIf(!enabled)("COMPATIBILITY PASSED: successful hardlinks and retry preserve canonical inode and never overwrite", async () => {
      const { op, files } = await fixture(), seal = await sealPreparedArtifacts(db, driver, op, files), canonical = path.join(dir, "canonical");
      await publishSealedArtifacts(db, driver, op, files, seal!, canonical);
      const before = await lstat(path.join(canonical, op.mainKey), { bigint: true });
      await publishSealedArtifacts(db, driver, op, files, seal!, canonical);
      expect((await lstat(path.join(canonical, op.mainKey), { bigint: true })).ino).toBe(before.ino);
      expect(await readFile(path.join(canonical, op.mainKey), "utf8")).toBe("synthetic-main");
    });
    it.skipIf(!enabled)("#470 mixed own generations authenticate main/thumb independently after partial publication", async () => {
      const { op, files } = await fixture(), first = await sealPreparedArtifacts(db, driver, op, files), canonical = path.join(dir, "canonical");
      await mkdir(canonical); await link(files.main, path.join(canonical, op.mainKey)); // generation 1 published only main
      await q(sql`UPDATE photo_operations SET lease_until_ms=0 WHERE id=${op.id} RETURNING id`);
      const claim = await tx(() => claimExistingOperation(driver, op.id, 300_000));
      if (claim.kind !== "owned") throw new Error("fixture reclaim failed");
      const generationDir = await createGenerationDirectory(claim.op, canonical);
      const next = { main: path.join(generationDir, "main.webp"), thumb: path.join(generationDir, "thumb.webp") };
      await writeFile(next.main, "synthetic-main"); await writeFile(next.thumb, "synthetic-thumb");
      const second = await sealPreparedArtifacts(db, driver, claim.op, next);
      await publishSealedArtifacts(db, driver, claim.op, next, second!, canonical);
      await publishSealedArtifacts(db, driver, claim.op, next, second!, canonical); // identical retry
      expect(String((await lstat(path.join(canonical, op.mainKey), { bigint: true })).ino)).toBe(first!.main.ino);
      expect(String((await lstat(path.join(canonical, op.thumbKey), { bigint: true })).ino)).toBe(second!.thumb.ino);
    });

    for (const mode of ["symlink", "fifo", "mutation", "EIO", "ENOSPC", "unknown"] as const) {
      it.skipIf(!enabled || (process.platform === "win32" && (mode === "symlink" || mode === "fifo")))(`#470 prior-generation ${mode}: review only proven not-live evidence; retain canonical`, async () => {
        const { op, files } = await fixture(), seal = await sealPreparedArtifacts(db, driver, op, files), canonical = path.join(dir, "canonical");
        await publishSealedArtifacts(db, driver, op, files, seal!, canonical);
        await q(sql`UPDATE photo_operations SET lease_until_ms=0 WHERE id=${op.id} RETURNING id`);
        const claim = await tx(() => claimExistingOperation(driver, op.id, 300_000));
        if (claim.kind !== "owned") throw new Error("fixture reclaim failed");
        const generationDir = await createGenerationDirectory(claim.op, canonical);
        const nextFiles = { main: path.join(generationDir, "main.webp"), thumb: path.join(generationDir, "thumb.webp") };
        await writeFile(nextFiles.main, "synthetic-main"); await writeFile(nextFiles.thumb, "synthetic-thumb");
        const nextSeal = await sealPreparedArtifacts(db, driver, claim.op, nextFiles);
        const before = await lstat(path.join(canonical, op.mainKey), { bigint: true });
        if (mode === "symlink" || mode === "fifo") {
          await rename(files.main, files.main + ".retained");
          if (mode === "symlink") await symlink(files.main + ".retained", files.main);
          else expect(spawnSync("mkfifo", [files.main]).status).toBe(0);
        } else if (mode === "mutation") {
          audit.afterRead = async name => { if (name !== files.main) return; audit.afterRead = undefined; await writeFile(files.main, "mutated-evidence"); };
        } else {
          audit.afterStat = async name => { if (name !== files.main) return; audit.afterStat = undefined; throw Object.assign(new Error("proof I/O failure"), { code: mode === "unknown" ? "EUNKNOWN" : mode }); };
        }
        const attempt = publishSealedArtifacts(db, driver, claim.op, nextFiles, nextSeal!, canonical);
        if (mode === "symlink" || mode === "fifo" || mode === "mutation") {
          await expect(attempt).rejects.toMatchObject({ status: 409, code: "PHOTO_OPERATION_REVIEW" });
          expect((await q(sql`SELECT state FROM photo_operations WHERE id=${op.id}`))[0].state).toBe("review");
        } else {
          await expect(attempt).rejects.toMatchObject({ code: mode === "unknown" ? "EUNKNOWN" : mode });
          expect((await q(sql`SELECT state FROM photo_operations WHERE id=${op.id}`))[0].state).toBe("sealed");
        }
        expect((await lstat(path.join(canonical, op.mainKey), { bigint: true })).ino).toBe(before.ino);
      });
    }

    it.skipIf(!enabled)("VULNERABILITY REPRODUCED F2: replaced A still links before its DB ownership can be rejected", async () => {
      const { op, files } = await fixture(), seal = await sealPreparedArtifacts(db, driver, op, files);
      await q(sql`UPDATE photo_operations SET lease_until_ms=0 WHERE id=${op.id} RETURNING id`);
      const claim = await tx(() => claimExistingOperation(driver, op.id, 300_000));
      expect(claim.kind).toBe("owned"); if (claim.kind !== "owned") throw new Error("fixture claim failed");
      const canonical = path.join(dir, "canonical"); await publishSealedArtifacts(db, driver, op, files, seal!, canonical);
      expect(String((await lstat(path.join(canonical, op.mainKey), { bigint: true })).ino)).toBe(seal!.main.ino);
      const row = (await q(sql`SELECT generation,state FROM photo_operations WHERE id=${op.id}`))[0];
      expect(Number(row.generation)).toBe(2); expect(row.state).toBe("preparing"); // no security PASS: stale canonical mutation still occurred
    });
  });
});
