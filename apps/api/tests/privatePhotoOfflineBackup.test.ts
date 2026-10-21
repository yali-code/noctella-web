import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createPrivatePhotoOfflineBackupUseCase, verifyPrivatePhotoOfflineBundle } from "../src/use-cases/private-photo-backup/useCases";
import * as proofs from "../src/services/ownedPhotoArtifactProof";
import * as fsPromises from "node:fs/promises";
import { capturePrivatePhotoColdBackup, verifyPrivatePhotoColdBundle } from "../src/use-cases/private-photo-backup/useCases";
import { runPrivatePhotoColdBackupCommand } from "../src/scripts/privatePhotoColdBackup";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
function insert(db: Database.Database, table: string, row: Record<string, unknown>) {
  db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "noctella-private-photo-proof-")); roots.push(root);
  const source = path.join(root, "source"); await mkdir(source);
  const db = new Database(path.join(source, "database.sqlite"));
  db.exec(readFileSync(path.resolve("src/db/schema.sql"), "utf8"));
  insert(db, "photo_storage_roots", { id: "root", identity: "synthetic-test-only", created_ms: 1 });
  // Sentinel proves this is a full DB copy, not a handpicked authority export.
  db.exec("CREATE TABLE acceptance_sentinel (value TEXT); INSERT INTO acceptance_sentinel VALUES ('disposable-only')");
  const seal: Record<string, unknown> = { id: "seal", operation_id: "op", generation: 1, relative_path: "op/1", created_ms: 1 };
  insert(db, "photo_operations", { id: "op", kind: "product_upload", subject_type: "test", subject_id: "subject", target_photo_id: "photo", main_key: "main.webp", thumb_key: "thumb.webp", input_sha256: "a".repeat(64), generation: 1, owner: "owner", nonce: "nonce", state: "sealed", lease_until_ms: 1, seal_id: "seal", created_ms: 1, updated_ms: 1 });
  insert(db, "photo_operation_generations", { operation_id: "op", generation: 1, owner: "owner", nonce: "nonce", state: "active", created_ms: 1, updated_ms: 1 });
  for (const role of ["main", "thumb"]) {
    const relative = `operations/op/1/${role}.webp`, file = path.join(source, relative), bytes = Buffer.from(`disposable-${role}`);
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes);
    const info = await lstat(file, { bigint: true });
    Object.assign(seal, { [`${role}_sha256`]: sha(bytes), [`${role}_bytes`]: bytes.length, [`${role}_dev`]: String(info.dev), [`${role}_ino`]: String(info.ino) });
  }
  insert(db, "photo_operation_artifacts", seal);
  const intent: Record<string, unknown> = { operation_id: "op", generation: 1, owner: "owner", nonce: "nonce", seal_id: "seal", main_key: "main.webp", thumb_key: "thumb.webp", executor_epoch: 1, executor_token: "token", executor_identity: "synthetic-offline", state: "authorized", created_ms: 1, updated_ms: 1 };
  for (const role of ["main", "thumb"]) for (const field of ["sha256", "dev", "ino"]) intent[`${role}_${field}`] = seal[`${role}_${field}`];
  insert(db, "photo_publication_intents", intent);
  for (const role of ["main", "thumb"]) {
    const file = path.join(source, `publication/op/${role}/data-0123456789abcdef`), bytes = Buffer.from(`disposable-${role}`);
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes);
    const info = await lstat(file, { bigint: true });
    insert(db, "photo_publication_copies", { operation_id: "op", artifact: role, executor_epoch: 1, staging_name: "data-0123456789abcdef", copy_dev: String(info.dev), copy_ino: String(info.ino), copy_birth_ns: String(info.birthtimeNs), sha256: sha(bytes), bytes: bytes.length, recorded_ms: 1 });
  }
  insert(db, "photo_executor_exit_records", { operation_id: "op", executor_epoch: 1, executor_identity: "synthetic-offline", attested_by: "fixture-not-real-exit-proof", exit_observed_ms: 1 });
  db.close();
  return { root, source, edit(fn: (db: Database.Database) => void) { const db = new Database(path.join(source, "database.sqlite")); try { fn(db); } finally { db.close(); } } };
}
const capture = (root: string) => createPrivatePhotoOfflineBackupUseCase().execute(root, "disposable-point-1");

it("materializes full authority DB and retained generations/anchors together without changing source", async () => {
  const f = await fixture(), before = await readFile(path.join(f.source, "database.sqlite"));
  const result = await capture(f.root);
  expect(result.files).toBe(5);
  expect(await verifyPrivatePhotoOfflineBundle(f.root, result.manifestSha256)).toEqual({ integrity: "ok", files: 5, runnableRecovery: false });
  const db = new Database(path.join(f.root, "bundle/payload/database.sqlite"), { readonly: true });
  try {
    expect(db.prepare("SELECT value FROM acceptance_sentinel").pluck().get()).toBe("disposable-only");
    expect(db.prepare("SELECT attested_by FROM photo_executor_exit_records").pluck().get()).toBe("fixture-not-real-exit-proof");
  } finally { db.close(); }
  expect(await readFile(path.join(f.source, "database.sqlite"))).toEqual(before);
  await expect(capture(f.root)).rejects.toThrow(); // exclusive, never overwrites retained evidence
}, 30000);

it.each(["operations/op/1/raw.jpeg", "publication/op/main/data-ffffffffffffffff"])("rejects unsealed/unrecorded source content: %s", async name => {
  const f = await fixture(); await writeFile(path.join(f.source, name), "not-authorized");
  await expect(capture(f.root)).rejects.toThrow();
});

it.each(["operations/op/1/main.webp", "publication/op/main/data-0123456789abcdef"])("rejects missing nonterminal artifact: %s", async name => {
  const f = await fixture(); await rm(path.join(f.source, name));
  await expect(capture(f.root)).rejects.toThrow();
});

it.each([
  "UPDATE photo_operation_generations SET owner='foreign'",
  "UPDATE photo_operations SET seal_id='missing'",
  "UPDATE photo_operation_generations SET state='committed'",
  "UPDATE photo_publication_intents SET state='committed'",
  "UPDATE photo_publication_copies SET executor_epoch=2",
  "UPDATE photo_operation_artifacts SET main_bytes=16777217",
])("rejects inconsistent authority or resource bound: %s", async sql => {
  const f = await fixture(); f.edit(db => db.exec(sql));
  await expect(capture(f.root)).rejects.toThrow();
});

it("permits positively committed pair/anchor absence after existing T2 cleanup", async () => {
  const f = await fixture();
  f.edit(db => db.exec("UPDATE photo_operations SET state='committed', committed_photo_id='photo'; UPDATE photo_operation_generations SET state='committed'; UPDATE photo_publication_intents SET state='committed'"));
  await rm(path.join(f.source, "operations"), { recursive: true }); await rm(path.join(f.source, "publication"), { recursive: true });
  const result = await capture(f.root);
  expect((await verifyPrivatePhotoOfflineBundle(f.root, result.manifestSha256)).files).toBe(1);
});

it.each(["bundle/payload/operations/op/1/main.webp", "bundle/manifest.json", "bundle/payload/database.sqlite"])("detects post-capture tampering: %s", async name => {
  const f = await fixture(), result = await capture(f.root);
  await writeFile(path.join(f.root, name), "tampered");
  await expect(verifyPrivatePhotoOfflineBundle(f.root, result.manifestSha256)).rejects.toThrow();
});

it("rejects a directory junction and an unknown empty generation", async () => {
  const f = await fixture();
  await mkdir(path.join(f.root, "foreign"));
  await symlink(path.join(f.root, "foreign"), path.join(f.source, "operations/foreign"), process.platform === "win32" ? "junction" : "dir");
  await expect(capture(f.root)).rejects.toThrow();
  await rm(path.join(f.source, "operations/foreign"));
  await mkdir(path.join(f.source, "operations/op/2"));
  await expect(capture(f.root)).rejects.toThrow();
});

it("fails closed on mutation after source hashing, retaining no completion manifest", async () => {
  const f = await fixture(), original = proofs.ownedPhotoArtifactProof;
  let changed = false;
  vi.spyOn(proofs, "ownedPhotoArtifactProof").mockImplementation(async (file, persistent) => {
    const proof = await original(file, persistent);
    if (!changed && file.endsWith(path.join("operations", "op", "1", "main.webp"))) { changed = true; await writeFile(file, "mutated"); }
    return proof;
  });
  await expect(capture(f.root)).rejects.toThrow();
  await expect(lstat(path.join(f.root, "bundle/manifest.json"))).rejects.toThrow();
});

it("refuses runtime use outside test and refuses WAL-mode sources", async () => {
  const f = await fixture();
  vi.stubEnv("NODE_ENV", "production"); await expect(capture(f.root)).rejects.toThrow();
  vi.stubEnv("NODE_ENV", "test"); f.edit(db => { db.pragma("journal_mode = WAL"); });
  await expect(capture(f.root)).rejects.toThrow();
});

it("refuses unverifiable persistent source identity rather than substituting content equality", async () => {
  const f = await fixture();
  f.edit(db => db.exec("UPDATE photo_operation_artifacts SET main_dev='pfs1:00000000000000000000000000000001:1'; UPDATE photo_publication_intents SET main_dev='pfs1:00000000000000000000000000000001:1'"));
  await expect(capture(f.root)).rejects.toThrow();
});

it("rejects a sealed operation's missing seal even without a publication intent", async () => {
  const f = await fixture();
  f.edit(db => db.exec("DELETE FROM photo_publication_copies; DELETE FROM photo_executor_exit_records; DELETE FROM photo_publication_intents; UPDATE photo_operations SET seal_id='missing'"));
  await rm(path.join(f.source, "publication"), { recursive: true });
  await expect(capture(f.root)).rejects.toThrow();
});

// Simulated POSIX destination metadata only; this does not establish Windows ACLs, encryption or target readiness.
async function withPrivateDestination(root: string, run: () => Promise<void>) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "getuid"), original = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).lstat;
  Object.defineProperty(process, "getuid", { configurable: true, value: () => 0 });
  vi.spyOn(fsPromises, "lstat").mockImplementation((async (name: any, options: any) => {
    const value = await original(name, options);
    if (![root, path.join(root, "operational-bundle"), path.join(root, "source/operations")].includes(String(name))) return value;
    return Object.assign(Object.create(value), { uid: 0, mode: 0o40700 });
  }) as typeof fsPromises.lstat);
  try { await run(); } finally {
    vi.restoreAllMocks();
    if (descriptor) Object.defineProperty(process, "getuid", descriptor); else Reflect.deleteProperty(process, "getuid");
  }
}

it("owner command includes committed retained derivatives/anchors from explicit cold roots and verifies without replay", async () => {
  const f = await fixture();
  f.edit(db => db.exec("UPDATE photo_operations SET state='committed', committed_photo_id='photo'; UPDATE photo_operation_generations SET state='committed'; UPDATE photo_publication_intents SET state='committed'"));
  await withPrivateDestination(f.root, async () => {
    const request = { source: { database: path.join(f.source, "database.sqlite"), operations: path.join(f.source, "operations"), publication: path.join(f.source, "publication") }, destination: path.join(f.root, "operational-bundle"), recoveryPointId: "cold-1", quiescenceEvidenceRef: "operator-cold-record-1", confidentialityEvidenceRef: "operator-storage-record-1", requiredRetainedOperationIds: ["op"] };
    const file = path.join(f.root, "operator.json"); await writeFile(file, JSON.stringify(request));
    const result = await runPrivatePhotoColdBackupCommand(["capture", file]) as Awaited<ReturnType<typeof capturePrivatePhotoColdBackup>>;
    expect(result).toMatchObject({ files: 5, scope: "owner-operated-cold-evidence-only", sourcePrerequisite: "operator-evidence-not-machine-proven", runnableRecovery: false });
    expect(await runPrivatePhotoColdBackupCommand(["verify", request.destination, result.manifestSha256])).toEqual({ integrity: "ok", files: 5, runnableRecovery: false });
    expect(JSON.parse(await readFile(path.join(request.destination, "manifest.json"), "utf8")).operatorPrerequisite.requiredRetainedOperationIds).toEqual(["op"]);
    await expect(capturePrivatePhotoColdBackup({ ...request, destination: path.join(f.source, "operations", "bad-output") })).rejects.toThrow();
    await writeFile(path.join(request.destination, "payload/operations/op/1/main.webp"), "tampered");
    await expect(verifyPrivatePhotoColdBundle(request.destination, result.manifestSha256)).rejects.toThrow();
  });
}, 60000);

it("required committed retention cannot use the historical-absence exception", async () => {
  const f = await fixture();
  f.edit(db => db.exec("UPDATE photo_operations SET state='committed', committed_photo_id='photo'; UPDATE photo_operation_generations SET state='committed'; UPDATE photo_publication_intents SET state='committed'"));
  await rm(path.join(f.source, "operations/op/1/main.webp")); await rm(path.join(f.source, "operations/op/1/thumb.webp"));
  await withPrivateDestination(f.root, async () => {
    await expect(capturePrivatePhotoColdBackup({ source: { database: path.join(f.source, "database.sqlite"), operations: path.join(f.source, "operations"), publication: path.join(f.source, "publication") }, destination: path.join(f.root, "operational-bundle"), recoveryPointId: "cold-2", quiescenceEvidenceRef: "cold-record", confidentialityEvidenceRef: "storage-record", requiredRetainedOperationIds: ["op"] })).rejects.toThrow();
  });
});

it("rejects absent operator prerequisites, unprotected local destinations and invalid CLI invocation", async () => {
  await expect(capturePrivatePhotoColdBackup({} as any)).rejects.toThrow();
  await expect(runPrivatePhotoColdBackupCommand(["capture"])).rejects.toThrow("Usage:");
  if (process.platform === "win32") {
    const f = await fixture();
    await expect(capturePrivatePhotoColdBackup({ source: { database: path.join(f.source, "database.sqlite"), operations: path.join(f.source, "operations"), publication: path.join(f.source, "publication") }, destination: path.join(f.root, "operational-bundle"), recoveryPointId: "cold-3", quiescenceEvidenceRef: "cold-record", confidentialityEvidenceRef: "storage-record", requiredRetainedOperationIds: ["op"] })).rejects.toThrow("PRIVATE_BACKUP_DESTINATION_CONFIDENTIALITY_UNVERIFIED");
  }
});
