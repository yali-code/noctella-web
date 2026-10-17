/** #462 TEST-ONLY hostile proof/grant verification. No 0042 execution or live integration. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rename, symlink, lstat, readdir, rm, link } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { rootedDescriptorProof } from "./support/rootedDescriptorProof462";
import { auditStore, type AuditDriver, type Seal } from "./support/publicationAuthority462";
let sandbox: string;
beforeEach(async () => { sandbox = await mkdtemp(path.join(os.tmpdir(), "noctella-462-")); });
afterEach(async () => {
  const target = path.resolve(sandbox);
  if (!target.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(target).startsWith("noctella-462-")) throw new Error("UNSAFE_CLEANUP");
  await rm(target, { recursive: true, force: true });
});
it.runIf(process.env.AUDIT462_REQUIRE_POSTGRES === "1")("required PostgreSQL evidence cannot skip", () => expect(Boolean(process.env.POSTGRES_TEST_DATABASE_URL)).toBe(true));
const write = async () => { const file = path.join(sandbox, "file"); await writeFile(file, "original", { flag: "wx", mode: 0o600 }); return file; };
const junction = (target: string, name: string) => symlink(target, name, process.platform === "win32" ? "junction" : "dir");
describe("F1 descriptor/root checks under documented ACL model", () => {
  it("PASS exact bounded bytes/hash/inode and requested private mode", async () => {
    const file = await write(), stat = await lstat(file, { bigint: true }), proof = await rootedDescriptorProof(sandbox, "file");
    expect(proof).toEqual({ sha256: createHash("sha256").update("original").digest("hex"), bytes: 8, dev: String(stat.dev), ino: String(stat.ino) });
    if (process.platform !== "win32") expect(Number(stat.mode) & 0o777).toBe(0o600);
    await expect(rootedDescriptorProof(sandbox, "file", 7)).rejects.toThrow();
  });
  it("PASS swap between validation and open cannot mix hash and inode", async () => {
    const file = await write();
    await expect(rootedDescriptorProof(sandbox, "file", 100, { beforeOpen: async () => { await rename(file, file + ".old"); await writeFile(file, "replacement"); } })).rejects.toThrow("AUDIT_FILE_PROOF_REFUSED");
  });
  it("PASS replacement after descriptor read is refused", async () => {
    const file = await write();
    await expect(rootedDescriptorProof(sandbox, "file", 100, { afterRead: async () => { await rename(file, file + ".old"); await writeFile(file, "original"); } })).rejects.toThrow("AUDIT_FILE_PROOF_REFUSED");
  });
  it("PASS in-place growth rejects post-read metadata change", async () => {
    const file = await write();
    await expect(rootedDescriptorProof(sandbox, "file", 100, { afterRead: () => writeFile(file, "longer replacement") })).rejects.toThrow("AUDIT_FILE_PROOF_REFUSED");
  });
  it("PASS existing ancestor symlink or junction rejected", async () => {
    const outside = path.join(sandbox, "outside"); await mkdir(outside); await writeFile(path.join(outside, "file"), "outside-synthetic");
    await junction(outside, path.join(sandbox, "alias")); await expect(rootedDescriptorProof(sandbox, "alias/file")).rejects.toThrow("AUDIT_FILE_PROOF_REFUSED");
  });
  it.runIf(process.platform !== "win32")("PASS ancestor replaced during read is refused", async () => {
    const dir = path.join(sandbox, "dir"); await mkdir(dir); await writeFile(path.join(dir, "file"), "original");
    await expect(rootedDescriptorProof(sandbox, "dir/file", 100, { afterRead: async () => { await rename(dir, dir + ".old"); await junction(dir + ".old", dir); } })).rejects.toThrow("AUDIT_FILE_PROOF_REFUSED");
  });
  it.each(["../outside", "sub/../../outside", "", "/outside"])("PASS rejects non-rooted %s", async relative => { await expect(rootedDescriptorProof(sandbox, relative)).rejects.toThrow(); });
  it.runIf(process.platform !== "win32")("LIMIT swap-and-restore ancestor can evade snapshots outside the ACL model", async () => {
    const approved = path.join(sandbox, "approved"), dir = path.join(approved, "dir"), outside = path.join(sandbox, "outside-dir");
    await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, "file"), "original");
    const proof = await rootedDescriptorProof(approved, "dir/file", 100, {
      beforeOpen: async () => { await rename(dir, outside); await junction(outside, dir); },
      afterRead: async () => { await (await import("node:fs/promises")).unlink(dir); await rename(outside, dir); },
    });
    expect(proof.sha256).toBe(createHash("sha256").update("original").digest("hex"));
  });
  it.runIf(process.platform !== "win32")("PASS final POSIX symlink rejected", async () => {
    await write(); await symlink(path.join(sandbox, "file"), path.join(sandbox, "alias")); await expect(rootedDescriptorProof(sandbox, "alias")).rejects.toThrow();
  });
});
describe.each([["sqlite", true], ["postgres", Boolean(process.env.POSTGRES_TEST_DATABASE_URL)]] as const)("F2 durable publication-intent protocol on real %s", (driver, enabled) => {
  let store: Awaited<ReturnType<typeof auditStore>> | undefined, root: string, a: Seal, b: Seal;
  beforeEach(async () => {
    if (!enabled) return; root = path.join(sandbox, "storage"); await mkdir(root); store = await auditStore(driver as AuditDriver, sandbox);
    const make = async (generation: number) => {
      const relative = generation + ".jpg"; await writeFile(path.join(root, relative), "synthetic-immutable-JPEG", { flag: "wx", mode: 0o600 });
      return { ...(await rootedDescriptorProof(root, relative)), generation, owner: randomUUID(), nonce: randomUUID(), relative };
    };
    a = await make(1); b = await make(2); await store.seed(a);
  });
  afterEach(async () => { await store?.close(); store = undefined; });
  it.skipIf(!enabled)("REPRO pre-link check alone still lets stale A publish", async () => {
    const s = await store!.connect();
    try {
      const old = (await s.q("SELECT * FROM audit_publication_guard WHERE id='one'"))[0]; expect(Number(old.generation)).toBe(1);
      await store!.expire(); await store!.reclaim(b); await link(path.join(root, a.relative), path.join(root, "canonical.jpg"));
      expect(await s.q("UPDATE audit_publication_guard SET state='committed' WHERE id='one' AND generation=1 RETURNING id")).toHaveLength(0);
      expect(String((await lstat(path.join(root, "canonical.jpg"), { bigint: true })).ino)).toBe(a.ino);
    } finally { await s.close(); }
  });
  it.skipIf(!enabled)("PASS B replaces expired A; resumed A cannot reach link", async () => {
    await store!.expire(); await store!.reclaim(b); let reached = false;
    await expect(store!.publish(root, a, { beforeLink: async () => { reached = true; } })).rejects.toThrow("AUDIT_GRANT_REFUSED");
    expect(reached).toBe(false); expect(await readdir(root)).not.toContain("canonical.jpg");
    expect((await store!.publish(root, b)).ino).toBe(b.ino); expect((await store!.row()).state).toBe("committed");
  });
  it.skipIf(!enabled)("PASS expiry without replacement denies grant", async () => {
    await store!.expire(); await expect(store!.publish(root, a)).rejects.toThrow("AUDIT_GRANT_REFUSED"); expect(await readdir(root)).not.toContain("canonical.jpg");
  });
  it.skipIf(!enabled)("PASS owner and nonce identity independently enforced", async () => {
    await expect(store!.publish(root, { ...a, owner: randomUUID() })).rejects.toThrow("AUDIT_GRANT_REFUSED");
    await expect(store!.publish(root, { ...a, nonce: randomUUID() })).rejects.toThrow("AUDIT_GRANT_REFUSED"); expect(await readdir(root)).not.toContain("canonical.jpg");
  });
  it.skipIf(!enabled)("PASS locked grant survives deadline crossing and blocks reclaim", async () => {
    const timer = await store!.connect(); try { await timer.q(`UPDATE audit_publication_guard SET lease_ms=${store!.nowSql}+2000 WHERE id='one'`); } finally { await timer.close(); }
    await store!.publish(root, a, { locked: async s => {
      const clock = (await s.q(`SELECT lease_ms-${store!.nowSql} AS remaining FROM audit_publication_guard WHERE id='one'`))[0];
      await new Promise(resolve => setTimeout(resolve, Math.max(0, Number(clock.remaining)) + 50)); // real database-clock deadline crossing
      let blocked = false;
      try { await store!.reclaim(b); } catch (error: any) { blocked = driver === "sqlite" ? /locked/i.test(error.message) : error.code === "55P03"; }
      expect(blocked).toBe(true);
    } });
    expect((await store!.row()).state).toBe("committed"); expect(Number((await store!.row()).generation)).toBe(1);
    await expect(store!.reclaim(b)).rejects.toThrow("AUDIT_RECLAIM_REFUSED");
  });
  it.skipIf(!enabled)("PASS pre-link interruption retains intent and creates no canonical", async () => {
    await expect(store!.publish(root, a, { beforeLink: async () => { throw new Error("interrupt-before-link"); } })).rejects.toThrow("interrupt-before-link");
    expect((await store!.row()).state).toBe("publishing"); expect(await readdir(root)).not.toContain("canonical.jpg");
  });
  it.skipIf(!enabled)("PASS post-link interruption recovers only the same durable intent", async () => {
    await expect(store!.publish(root, a, { afterLink: async () => { throw new Error("interrupt-after-link"); } })).rejects.toThrow("interrupt-after-link");
    const inode = (await lstat(path.join(root, "canonical.jpg"), { bigint: true })).ino; expect((await store!.row()).state).toBe("publishing");
    await store!.expire(); await expect(store!.reclaim(b)).rejects.toThrow("AUDIT_RECLAIM_REFUSED");
    expect((await store!.publish(root, a)).ino).toBe(String(inode));
    expect(Number((await store!.row()).canonical_generation)).toBe(1); expect((await store!.row()).state).toBe("committed");
  });
  it.skipIf(!enabled)("PASS same-byte foreign inode is refused without overwrite", async () => {
    const file = path.join(root, "canonical.jpg"); await writeFile(file, "synthetic-immutable-JPEG", { flag: "wx" }); const inode = (await lstat(file, { bigint: true })).ino;
    await expect(store!.publish(root, a)).rejects.toThrow("AUDIT_PROVENANCE_REVIEW"); expect((await lstat(file, { bigint: true })).ino).toBe(inode); expect((await store!.row()).state).toBe("publishing");
  });
  it.skipIf(!enabled)("PASS private seal tamper is refused before publication", async () => {
    await writeFile(path.join(root, a.relative), "tampered"); await expect(store!.publish(root, a)).rejects.toThrow("AUDIT_SEAL_CHANGED"); expect(await readdir(root)).not.toContain("canonical.jpg");
  });
  it.skipIf(!enabled)("REPRO lock-only authority disappears when its connection closes", async () => {
    const old = await store!.connect(); await old.begin(); await old.q("UPDATE audit_publication_guard SET nonce=nonce WHERE id='one'");
    await old.close(); // actual transaction rollback/connection release; A's process can still run
    await store!.expire(); await store!.reclaim(b); await link(path.join(root, a.relative), path.join(root, "canonical.jpg"));
    expect(String((await lstat(path.join(root, "canonical.jpg"), { bigint: true })).ino)).toBe(a.ino);
    expect(Number((await store!.row()).generation)).toBe(2);
  });
  it.skipIf(!enabled)("PASS durable intent blocks B after all entry DB connections close", async () => {
    await store!.publish(root, a, { granted: async () => {
      expect((await store!.row()).state).toBe("publishing"); await store!.expire();
      await expect(store!.reclaim(b)).rejects.toThrow("AUDIT_RECLAIM_REFUSED");
    } });
    expect((await store!.row()).state).toBe("committed"); expect(Number((await store!.row()).generation)).toBe(1);
  });
  it.skipIf(!enabled)("PASS lost acknowledgement retry verifies committed intent without linking again", async () => {
    await expect((async () => { await store!.publish(root, a); throw new Error("lost-ack"); })()).rejects.toThrow("lost-ack");
    expect((await store!.row()).state).toBe("committed");
    const result = await store!.publish(root, a, { beforeLink: async () => { throw new Error("must-not-link"); } }); expect(result.ino).toBe(a.ino);
  });
});
