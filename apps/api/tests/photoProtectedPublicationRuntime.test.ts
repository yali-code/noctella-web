/**
 * Stage 5 F2 (#472) runtime acceptance of the protected-publication building blocks used by the real W2/W4 owners:
 * the copy-owned publisher, the executor exit authenticator, fail-closed readiness and operator exit attestation.
 * Linux-only cases (real process death observed through /proc) run in the required Linux gate.
 */
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql, type SQL } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ensureSchema } from "../src/db/migrate";
import { publishVerifiedCopy, type CopyLedger, type CopyRecord } from "../src/services/photoCopyPublisher";
import {
  assertPhotoPublicationReady, authenticateExecutorExit, photoPublicationStorageProblem, crossProcessExitAuthenticationAvailable, openPublicationScope, publicationExecutorIdentity, resumeAfterAuthenticatedExit,
} from "../src/services/photoPublicationExecutor";
import { createOperation, inOwnershipTransaction, PHOTO_OPERATION_LEASE_MS, type OwnershipDriver } from "../src/services/photoOperationAuthority";
import { acquirePublicationIntent } from "../src/services/photoPublicationIntents";
import { attestExecutorExit, parseRecoveryArgs, reportPublicationIntents } from "../src/scripts/photoPublicationIntentRecovery";
import { createPostgresTestDb, postgresTestConfigured } from "./postgresTestDb";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "noctella-protected-publication-"));
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });
const linux = process.platform === "linux";

it.runIf(process.env.F2_CAPABILITY_REQUIRE_LINUX === "1")("required Linux execution of the protected-publication runtime suite", () => {
  expect(linux).toBe(true); expect(crossProcessExitAuthenticationAvailable()).toBe(true); expect(postgresTestConfigured).toBe(true);
});

function fixture(bytes = "sealed-bytes-" + randomUUID()) {
  const dir = fs.mkdtempSync(path.join(root, "pub-"));
  const source = path.join(dir, "private", "main.webp"), canonicalDir = path.join(dir, "canonical"), stagingDir = path.join(dir, "staging", "op", "main");
  fs.mkdirSync(path.dirname(source), { recursive: true }); fs.mkdirSync(canonicalDir);
  fs.writeFileSync(source, bytes);
  const st = fs.statSync(source, { bigint: true });
  const seal = { sha256: require("node:crypto").createHash("sha256").update(bytes).digest("hex"), size: Buffer.byteLength(bytes), dev: String(st.dev), ino: String(st.ino) };
  let recorded: CopyRecord | null = null;
  const events: string[] = [];
  const ledger: CopyLedger & { failNext?: boolean } = {
    async read() { return recorded; },
    async record(copy) {
      events.push(`record:canonical-exists=${fs.existsSync(path.join(canonicalDir, "k.webp"))}`);
      if (ledger.failNext) { ledger.failNext = false; throw new Error("PHOTO_OPERATION_FENCE_LOST"); }
      recorded = copy;
    },
  };
  return { dir, source, canonicalDir, stagingDir, seal, ledger, events, bytes, target: { source, seal, canonicalDir, canonicalName: "k.webp", stagingDir } };
}
const ident = (file: string) => { const st = fs.lstatSync(file, { bigint: true }); return { dev: String(st.dev), ino: String(st.ino), nlink: st.nlink }; };

describe("runtime copy-owned publisher", () => {
  it("publishes a verified, publisher-owned copy recorded BEFORE the canonical name exists; never the source inode", async () => {
    const f = fixture();
    const outcome = await publishVerifiedCopy(f.target, f.ledger);
    expect(outcome.kind).toBe("PUBLISHED");
    const canonical = ident(path.join(f.canonicalDir, "k.webp"));
    expect(canonical.ino).not.toBe(f.seal.ino); expect(canonical.nlink).toBe(1n);
    expect(f.events).toEqual(["record:canonical-exists=false"]);
    expect(fs.readFileSync(path.join(f.canonicalDir, "k.webp"), "utf8")).toBe(f.bytes);
    expect(fs.readdirSync(f.stagingDir)).toEqual([]); // own staging data cleaned
  });

  it("source aliases and retained descriptors cannot change published bytes (inverts the 470 LIMIT shape)", async () => {
    const f = fixture();
    const alias = path.join(f.dir, "private", "alias.webp"); fs.linkSync(f.source, alias);
    const retained = fs.openSync(f.source, "r+");
    try {
      expect((await publishVerifiedCopy(f.target, f.ledger)).kind).toBe("PUBLISHED");
      fs.writeFileSync(alias, "changed-via-private-alias"); fs.writeSync(retained, "XX", 0);
    } finally { fs.closeSync(retained); }
    expect(fs.readFileSync(path.join(f.canonicalDir, "k.webp"), "utf8")).toBe(f.bytes);
  });

  it("source mutation after the seal publishes nothing (SNAPSHOT_MISMATCH); replacement is SOURCE_REPLACED; missing is SOURCE_MISSING", async () => {
    const mutated = fixture("aaaaaaaaaaaaaaaa");
    fs.writeFileSync(mutated.source, "bbbbbbbbbbbbbbbb", { flag: "r+" }); // same inode, same size, different bytes
    expect((await publishVerifiedCopy(mutated.target, mutated.ledger)).kind).toBe("SNAPSHOT_MISMATCH");
    expect(fs.existsSync(path.join(mutated.canonicalDir, "k.webp"))).toBe(false);
    expect(fs.readdirSync(mutated.stagingDir)).toEqual([]);
    const replaced = fixture();
    fs.renameSync(replaced.source, replaced.source + ".old"); fs.writeFileSync(replaced.source, replaced.bytes);
    expect((await publishVerifiedCopy(replaced.target, replaced.ledger)).kind).toBe("SOURCE_REPLACED");
    expect(fs.existsSync(path.join(replaced.canonicalDir, "k.webp"))).toBe(false);
    const missing = fixture(); fs.rmSync(missing.source);
    expect((await publishVerifiedCopy(missing.target, missing.ledger)).kind).toBe("SOURCE_MISSING");
  });

  it("a foreign canonical file is never adopted, overwritten or cleaned (COLLISION), even with identical bytes", async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.canonicalDir, "k.webp"), f.bytes);
    const foreign = ident(path.join(f.canonicalDir, "k.webp"));
    expect((await publishVerifiedCopy(f.target, f.ledger)).kind).toBe("COLLISION");
    expect(ident(path.join(f.canonicalDir, "k.webp"))).toEqual(foreign);
    expect(f.events).toEqual([]); // nothing recorded for a foreign name
  });

  // Runtime owners keep the staging name as an anchor until commit (retainStagingLink), so the recorded inode can
  // never be freed and its number never handed to a foreign file (ext4 reuses freed inode numbers; birth times are coarse).
  it("anchored copy: canonical and staging anchor are one inode until commit; a recreated same-bytes file is foreign", async () => {
    const f = fixture(), target = { ...f.target, retainStagingLink: true };
    expect((await publishVerifiedCopy(target, f.ledger)).kind).toBe("PUBLISHED");
    const key = path.join(f.canonicalDir, "k.webp"), anchor = fs.readdirSync(f.stagingDir);
    expect(anchor).toHaveLength(1);
    expect(ident(path.join(f.stagingDir, anchor[0]))).toEqual({ ...ident(key), nlink: 2n });
    expect((await publishVerifiedCopy(target, f.ledger)).kind).toBe("ADOPTED"); // retry before commit
    const recorded = ident(key);
    fs.rmSync(key); fs.writeFileSync(key, f.bytes); // the anchor keeps the old inode alive: no number reuse possible
    expect(ident(key).ino).not.toBe(recorded.ino);
    expect((await publishVerifiedCopy(target, f.ledger)).kind).toBe("COLLISION");
    expect(fs.readFileSync(key, "utf8")).toBe(f.bytes); // untouched
  });

  it("anchored copy: a missing or replaced staging anchor never authorizes adoption (fail closed)", async () => {
    for (const mode of ["missing", "replaced"] as const) {
      const f = fixture(), target = { ...f.target, retainStagingLink: true };
      expect((await publishVerifiedCopy(target, f.ledger)).kind).toBe("PUBLISHED");
      const [name] = fs.readdirSync(f.stagingDir);
      fs.rmSync(path.join(f.stagingDir, name));
      if (mode === "replaced") fs.writeFileSync(path.join(f.stagingDir, name), f.bytes);
      expect((await publishVerifiedCopy(target, f.ledger)).kind, mode).toBe("COLLISION");
      expect(fs.readFileSync(path.join(f.canonicalDir, "k.webp"), "utf8")).toBe(f.bytes);
    }
  });

  it("crash after link adopts exactly the recorded inode; crash after record (before link) publishes a fresh copy", async () => {
    const linked = fixture();
    await expect(publishVerifiedCopy(linked.target, linked.ledger, (p) => { if (p === "linked") throw new Error("crash"); })).rejects.toThrow("crash");
    const first = ident(path.join(linked.canonicalDir, "k.webp"));
    const adopted = await publishVerifiedCopy(linked.target, linked.ledger);
    expect(adopted).toMatchObject({ kind: "ADOPTED", ino: first.ino });
    expect(fs.readdirSync(linked.stagingDir)).toEqual([]);
    const recorded = fixture();
    await expect(publishVerifiedCopy(recorded.target, recorded.ledger, (p) => { if (p === "recorded") throw new Error("crash"); })).rejects.toThrow("crash");
    expect(fs.existsSync(path.join(recorded.canonicalDir, "k.webp"))).toBe(false);
    expect((await publishVerifiedCopy(recorded.target, recorded.ledger)).kind).toBe("PUBLISHED");
    expect(fs.readdirSync(recorded.stagingDir)).toEqual([]);
  });

  it("disk exhaustion or lost authority during publication leaves no canonical name and removes only its own partial copy", async () => {
    const full = fixture();
    const enospc = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    await expect(publishVerifiedCopy(full.target, full.ledger, (p) => { if (p === "copy-partial") throw enospc; })).rejects.toMatchObject({ code: "ENOSPC" });
    expect(fs.existsSync(path.join(full.canonicalDir, "k.webp"))).toBe(false);
    expect(fs.readdirSync(full.stagingDir)).toEqual([]);
    fs.writeFileSync(path.join(full.stagingDir, "unrelated.txt"), "keep");
    const lost = { ...full, ledger: Object.assign(full.ledger, { failNext: true }) };
    await expect(publishVerifiedCopy(lost.target, lost.ledger)).rejects.toThrow("PHOTO_OPERATION_FENCE_LOST");
    expect(fs.existsSync(path.join(full.canonicalDir, "k.webp"))).toBe(false);
    expect(fs.readdirSync(full.stagingDir)).toEqual(["unrelated.txt"]); // never cleans foreign names
  });
});

describe("executor exit authenticator", () => {
  it("an execution of this process is proven ended only after its scope closed", () => {
    const scope = openPublicationScope(), me = scope.executor();
    expect(me.executorIdentity).toBe(publicationExecutorIdentity());
    expect(authenticateExecutorExit(me).proven).toBe(false);
    scope.close();
    expect(authenticateExecutorExit(me)).toMatchObject({ proven: true });
    expect(() => scope.executor()).toThrow("PHOTO_PUBLICATION_SCOPE_CLOSED");
  });

  it("unauthenticatable identities never prove termination (no lease, heartbeat or worker PID shortcut)", () => {
    for (const executorIdentity of ["worker-reported-pid:1234", "px1u:win32:4321:0123456789abcdef", "", "px1:not-a-boot:1:1:1:0123456789abcdef"])
      expect(authenticateExecutorExit({ token: randomUUID(), executorIdentity }).proven).toBe(false);
  });

  it.runIf(linux)("Linux: alive -> not proven; other boot or PID namespace -> not proven; SIGKILLed -> proven; PID reuse -> proven", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
      const self = publicationExecutorIdentity().split(":");
      const stat = fs.readFileSync(`/proc/${child.pid}/stat`, "utf8"), start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      const identity = (boot = self[1], ns = self[2], begin = start) => `px1:${boot}:${ns}:${child.pid}:${begin}:0123456789abcdef`;
      expect(authenticateExecutorExit({ token: "t", executorIdentity: identity() })).toMatchObject({ proven: false, reason: "the executor process is alive" });
      expect(authenticateExecutorExit({ token: "t", executorIdentity: identity("00000000-0000-0000-0000-000000000000") }).proven).toBe(false);
      expect(authenticateExecutorExit({ token: "t", executorIdentity: identity(undefined, "1") }).proven).toBe(false);
      expect(authenticateExecutorExit({ token: "t", executorIdentity: identity(undefined, undefined, String(Number(start) + 1)) })).toMatchObject({ proven: true });
      child.kill("SIGKILL"); await exited;
      expect(authenticateExecutorExit({ token: "t", executorIdentity: identity() })).toMatchObject({ proven: true });
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } }
  });
});

describe.each([["sqlite", true], ["postgres", postgresTestConfigured]] as const)("readiness and operator attestation on %s", (driver: OwnershipDriver, configured) => {
  const run = (name: string, fn: () => Promise<void>) => it.skipIf(!configured)(name, fn);
  async function database() {
    if (driver === "postgres") { const h = await createPostgresTestDb("0044_photo_publication_copies.sql"); return { db: h.db as any, raw: null as Database.Database | null, close: () => h.close() }; }
    const raw = new Database(":memory:"); raw.pragma("foreign_keys = ON"); ensureSchema(raw);
    return { db: drizzle(raw) as any, raw, close: async () => raw.close() };
  }
  const q = async (db: any, s: SQL): Promise<any[]> => driver === "sqlite" ? db.all(s) : (await db.execute(s)).rows;

  run("storage readiness reports symlinked, misowned or group-writable roots (misconfiguration detection only)", async () => {
    const parent = fs.mkdtempSync(path.join(root, "storage-")), canonical = path.join(parent, "photos");
    expect(photoPublicationStorageProblem(canonical)).toBeNull();
    if (process.platform === "linux") {
      fs.chmodSync(path.join(parent, ".product-photo-publication"), 0o770);
      expect(photoPublicationStorageProblem(canonical)).toBe("staging root is group- or world-writable");
      fs.chmodSync(path.join(parent, ".product-photo-publication"), 0o700);
      fs.chmodSync(canonical, 0o777);
      expect(photoPublicationStorageProblem(canonical)).toBe("canonical root is world-writable");
      fs.chmodSync(canonical, 0o755);
      const other = fs.mkdtempSync(path.join(root, "elsewhere-"));
      fs.rmSync(path.join(parent, ".product-photo-operations"), { recursive: true });
      fs.symlinkSync(other, path.join(parent, ".product-photo-operations"));
      expect(photoPublicationStorageProblem(canonical)).toBe("private root is a symbolic link");
    }
  });

  run("protected publication is NOT READY without its schema or with a non-directory root (fail closed, no fallback)", async () => {
    const h = await database();
    try {
      const canonical = fs.mkdtempSync(path.join(root, "ready-")) + "/photos";
      await expect(assertPhotoPublicationReady(h.db, driver, canonical)).resolves.toBeUndefined();
      const file = path.join(path.dirname(canonical), "as-file"); fs.writeFileSync(file, "x");
      await expect(assertPhotoPublicationReady(h.db, driver, file)).rejects.toMatchObject({ status: 503, code: "PHOTO_PUBLICATION_NOT_READY" });
      if (h.raw) h.raw.exec("DROP TABLE photo_publication_copies");
      else await h.db.execute(sql.raw("DROP TABLE photo_publication_copies"));
      await expect(assertPhotoPublicationReady(h.db, driver, canonical)).rejects.toMatchObject({ status: 503, code: "PHOTO_PUBLICATION_NOT_READY" });
    } finally { await h.close(); }
  });

  run("a BLOCKED intent is reported read-only; only an exact operator attestation lets a retry transfer authority", async () => {
    const h = await database();
    try {
      const photoId = randomUUID();
      const op = await inOwnershipTransaction(h.db, driver, () => createOperation(driver, { kind: "product_upload", subjectType: "w2_request", subjectId: randomUUID(), targetPhotoId: photoId, mainKey: `p-${photoId}.webp`, thumbKey: `p-${photoId}-thumb.webp`, inputSha256: "c".repeat(64) }, PHOTO_OPERATION_LEASE_MS));
      const sealId = randomUUID();
      await q(h.db, sql`INSERT INTO photo_operation_artifacts (id, operation_id, generation, relative_path, main_sha256, thumb_sha256, main_bytes, thumb_bytes, main_dev, main_ino, thumb_dev, thumb_ino, created_ms)
        VALUES (${sealId}, ${op.id}, 1, ${op.id + "/1"}, ${"a".repeat(64)}, ${"b".repeat(64)}, 1, 1, '1', '2', '1', '3', 1) RETURNING id`);
      await q(h.db, sql`UPDATE photo_operations SET state = 'sealed', seal_id = ${sealId} WHERE id = ${op.id} RETURNING id`);
      // An executor on another host/instance: this process can never observe it.
      const foreign = { token: randomUUID(), executorIdentity: "px1:00000000-0000-0000-0000-000000000000:1:1:1:0123456789abcdef" };
      expect((await acquirePublicationIntent(h.db, driver, op, sealId, foreign)).kind).toBe("own");
      const [report] = (await reportPublicationIntents(h.db, driver)).filter((r) => r.operationId === op.id);
      expect(report).toMatchObject({ state: "authorized", resumable: false, exitRecorded: false });
      expect(report.blockedReason).toBeTruthy();
      const scope = openPublicationScope();
      try {
        expect((await resumeAfterAuthenticatedExit(h.db, driver, op.id, scope)).kind).toBe("blocked");
        const evidence = "render deploy dep-123: instance srv-old stopped 12:04Z";
        const base = ["--attest-exit", "--operation", op.id, "--epoch", "1", "--executor", foreign.executorIdentity, "--operator", "ops"];
        expect(() => parseRecoveryArgs([...base, "--evidence", evidence])).toThrow("--confirm-executor-terminated");
        expect(() => parseRecoveryArgs([...base, "--confirm-executor-terminated"])).toThrow("missing --evidence");
        await expect(attestExecutorExit(h.db, driver, { operationId: op.id, epoch: 1, executorIdentity: foreign.executorIdentity, operator: "ops", evidence: "ok" })).rejects.toThrow("PHOTO_ATTESTATION_EVIDENCE_REQUIRED");
        await expect(attestExecutorExit(h.db, driver, { operationId: op.id, epoch: 1, executorIdentity: foreign.executorIdentity, operator: "ops", evidence: "a|b injected separator" })).rejects.toThrow("PHOTO_ATTESTATION_EVIDENCE_REQUIRED");
        expect(await attestExecutorExit(h.db, driver, { operationId: op.id, epoch: 2, executorIdentity: foreign.executorIdentity, operator: "ops", evidence })).toMatchObject({ recorded: false, reason: "intent epoch or executor changed" }); // stale/future epoch
        expect(await attestExecutorExit(h.db, driver, { operationId: op.id, epoch: 1, executorIdentity: "someone-else", operator: "ops", evidence })).toMatchObject({ recorded: false, reason: "intent epoch or executor changed" }); // mismatched executor
        expect((await resumeAfterAuthenticatedExit(h.db, driver, op.id, scope)).kind).toBe("blocked"); // nothing recorded so far
        const args = parseRecoveryArgs([...base, "--evidence", evidence, "--confirm-executor-terminated"]);
        if (args.mode !== "attest") throw new Error("expected attest");
        expect(await attestExecutorExit(h.db, driver, args.attestation)).toEqual({ recorded: true });
        expect(await attestExecutorExit(h.db, driver, args.attestation)).toMatchObject({ recorded: false, reason: "exit already recorded" }); // replay
        const resumed = await resumeAfterAuthenticatedExit(h.db, driver, op.id, scope);
        expect(resumed.kind).toBe("own");
        if (resumed.kind === "own") expect([resumed.authority.epoch, resumed.authority.executorIdentity]).toEqual([2, publicationExecutorIdentity()]);
        const [exit] = await q(h.db, sql`SELECT attested_by FROM photo_executor_exit_records WHERE operation_id = ${op.id} AND executor_epoch = 1`);
        expect(exit.attested_by).toBe(`operator:ops|${evidence}`);
        // Replaying the old attestation after the transfer is stale; the new executor (this process, still running) is
        // visibly alive here, so even an exact attestation of epoch 2 is refused.
        expect(await attestExecutorExit(h.db, driver, args.attestation)).toMatchObject({ recorded: false });
        expect(await attestExecutorExit(h.db, driver, { ...args.attestation, epoch: 2, executorIdentity: publicationExecutorIdentity() }))
          .toMatchObject({ recorded: false, reason: "refused: the executor is still running in this process" });
      } finally { scope.close(); }
    } finally { await h.close(); }
  });
});
