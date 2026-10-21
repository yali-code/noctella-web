/**
 * OFFLINE evidence only. No live DB/config/root discovery, route, scheduler or remote storage wiring.
 * A cold source must already exist; this module does not establish application quiescence.
 * Preserve full DB authority unchanged. A verified bundle is evidence, never permission to resume publication.
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ownedPhotoArtifactProof } from "../../services/ownedPhotoArtifactProof";
import { MAX_PRODUCT_PHOTO_BACKUP_ARTIFACT_BYTES } from "../../repositories/product-photo-backup/types";

const MAX_DB = 128 * 1024 * 1024, MAX_TOTAL = 512 * 1024 * 1024, MAX_FILES = 4096, MAX_ROWS = 10000;
const MAX_MANIFEST = 2 * 1024 * 1024;
const TABLES = ["photo_storage_roots", "photo_operations", "photo_operation_generations", "photo_operation_artifacts", "photo_publication_intents", "photo_executor_exit_records", "photo_publication_copies"] as const;
type Row = Record<string, any>;
type Binding = { path: string; sha256: string; bytes: number; dev: string; ino: string; birthNs?: string };
type Entry = { path: string; sha256: string; bytes: number };
type ColdSource = { database: string; operations: string; publication: string };
type Source = string | ColdSource;
export type ColdBackupRequest = {
  source: ColdSource; destination: string; recoveryPointId: string;
  quiescenceEvidenceRef: string; confidentialityEvidenceRef: string;
  /** Explicit expected retained operations from the operator's cold-source inventory; not publication authority. */
  requiredRetainedOperationIds: string[];
};
type Manifest = { version: 1; scope: "disposable-offline-evidence-only" | "owner-operated-cold-evidence-only"; recoveryPointId: string; entries: Entry[]; originalBindings: Binding[]; operatorPrerequisite?: Pick<ColdBackupRequest, "quiescenceEvidenceRef" | "confidentialityEvidenceRef" | "requiredRetainedOperationIds"> };
function fail(): never { throw new Error("PRIVATE_PHOTO_OFFLINE_EVIDENCE_INVALID"); }
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const component = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
const comparePath = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
function sourcePath(root: Source, name: string) {
  if (typeof root === "string") return path.join(root, name);
  if (name === "database.sqlite") return root.database;
  const [kind, ...parts] = name.split("/");
  if (kind !== "operations" && kind !== "publication") fail();
  return path.join(root[kind], ...parts);
}

async function directory(value: string) {
  const absolute = path.resolve(value), info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink() || comparePath(await realpath(absolute)) !== comparePath(absolute)) fail();
  return absolute;
}

async function disposableWorkspace(workspace: string) {
  if (process.env.NODE_ENV !== "test") fail();
  const root = await directory(workspace), temporary = await realpath(os.tmpdir());
  if (comparePath(path.dirname(root)) !== comparePath(temporary) || !path.basename(root).startsWith("noctella-private-photo-proof-")) fail();
  return root;
}

/** Fixed-depth, bounded inventory. Every ancestor is checked; no symlinks or unrelated root content accepted. */
async function inventory(root: Source) {
  const files: string[] = [], directories: string[] = [];
  let nodes = 0;
  async function visit(relative: string, depth: number) {
    const current = relative ? sourcePath(root, relative) : root as string;
    await directory(current);
    for await (const item of await opendir(current)) {
      if (++nodes > MAX_FILES * 3 || depth > 3) fail();
      const name = relative ? `${relative}/${item.name}` : item.name;
      if (!/^[A-Za-z0-9_.\/-]+$/.test(name) || item.name === "." || item.name === "..") fail();
      const info = await lstat(sourcePath(root, name));
      if (info.isSymbolicLink()) fail();
      if (info.isDirectory()) { directories.push(name); await visit(name, depth + 1); }
      else if (info.isFile()) { files.push(name); if (files.length > MAX_FILES) fail(); }
      else fail();
    }
  }
  if (typeof root === "string") await visit("", 0);
  else {
    await directory(path.dirname(root.database));
    const db = await lstat(root.database);
    if (!db.isFile() || db.isSymbolicLink()) fail();
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      try { await lstat(root.database + suffix); fail(); } catch (e: any) { if (e?.code !== "ENOENT") throw e; }
    }
    files.push("database.sqlite");
    for (const kind of ["operations", "publication"] as const) { directories.push(kind); await visit(kind, 1); }
  }
  return { files: files.sort(), directories: directories.sort() };
}

function authority(databasePath: string) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    if (db.pragma("integrity_check", { simple: true }) !== "ok" || db.prepare("PRAGMA foreign_key_check").get()) fail();
    const tables = Object.fromEntries(TABLES.map(table => {
      const rows = db.prepare(`SELECT * FROM ${table} LIMIT ${MAX_ROWS + 1}`).all() as Row[];
      if (rows.length > MAX_ROWS) fail();
      return [table, rows];
    })) as Record<typeof TABLES[number], Row[]>;
    return tables;
  } finally { db.close(); }
}

function bindings(t: ReturnType<typeof authority>, present: Set<string>, dirs: Set<string>, required: string[] = []) {
  const allowedDirs = new Set(["operations", "publication"]), expected = new Map<string, Binding>();
  const operations = new Map(t.photo_operations.map(o => [o.id, o]));
  const generations = new Map(t.photo_operation_generations.map(g => [`${g.operation_id}/${g.generation}`, g]));
  const seals = new Map(t.photo_operation_artifacts.map(a => [a.id, a]));
  const intents = new Map(t.photo_publication_intents.map(i => [i.operation_id, i]));
  if (required.length > MAX_ROWS || new Set(required).size !== required.length || required.some(id => !component(id) || !operations.has(id))) fail();
  for (const op of operations.values()) {
    if (!component(op.id)) fail();
    const current = generations.get(`${op.id}/${op.generation}`);
    if (!current || current.owner !== op.owner || current.nonce !== op.nonce) fail();
    if (["sealed", "committed"].includes(op.state)) {
      const seal = seals.get(op.seal_id);
      if (!seal || seal.operation_id !== op.id || seal.generation !== op.generation) fail();
      if (op.state === "sealed" && current.state !== "active") fail();
      if (op.state === "committed" && (current.state !== "committed" || op.committed_photo_id !== op.target_photo_id)) fail();
    }
    allowedDirs.add(`operations/${op.id}`); allowedDirs.add(`publication/${op.id}`);
    for (const role of ["main", "thumb"]) allowedDirs.add(`publication/${op.id}/${role}`);
  }
  for (const gen of generations.values()) {
    if (!operations.has(gen.operation_id) || !positive(gen.generation)) fail();
    allowedDirs.add(`operations/${gen.operation_id}/${gen.generation}`);
  }
  const add = (binding: Binding) => {
    if (!/^[a-f0-9]{64}$/.test(binding.sha256) || !positive(binding.bytes) || binding.bytes > MAX_PRODUCT_PHOTO_BACKUP_ARTIFACT_BYTES || !binding.dev || !binding.ino || expected.has(binding.path)) fail();
    expected.set(binding.path, binding);
  };
  for (const seal of seals.values()) {
    const relative = `${seal.operation_id}/${seal.generation}`, gen = generations.get(relative);
    if (!gen || seal.relative_path !== relative) fail();
    const operation = operations.get(seal.operation_id)!;
    const terminal = gen.state === "committed" && operation.state === "committed" && operation.generation === gen.generation && operation.seal_id === seal.id && operation.committed_photo_id === operation.target_photo_id;
    if (gen.state === "committed" && !terminal) fail();
    const names = ["main", "thumb"].map(role => `operations/${relative}/${role}.webp`);
    // Existing T2 cleanup can remove a committed generation's pair. Never infer loss for a nonterminal seal.
    const absent = names.every(name => !present.has(name));
    if (absent && terminal && !required.includes(seal.operation_id)) continue;
    for (const [index, role] of ["main", "thumb"].entries()) add({ path: names[index], sha256: seal[`${role}_sha256`], bytes: seal[`${role}_bytes`], dev: seal[`${role}_dev`], ino: seal[`${role}_ino`] });
  }
  for (const intent of intents.values()) {
    const op = operations.get(intent.operation_id), seal = seals.get(intent.seal_id), gen = generations.get(`${intent.operation_id}/${intent.generation}`);
    if (!op || !seal || !gen || seal.operation_id !== op.id || seal.generation !== intent.generation || gen.owner !== intent.owner || gen.nonce !== intent.nonce || op.main_key !== intent.main_key || op.thumb_key !== intent.thumb_key) fail();
    for (const role of ["main", "thumb"]) for (const field of ["sha256", "dev", "ino"]) if (intent[`${role}_${field}`] !== seal[`${role}_${field}`]) fail();
    if (intent.state === "authorized" && (op.generation !== intent.generation || op.state !== "sealed" || op.seal_id !== intent.seal_id)) fail();
    if (intent.state === "committed" && (op.state !== "committed" || gen.state !== "committed" || op.generation !== intent.generation || op.seal_id !== intent.seal_id)) fail();
  }
  for (const copy of t.photo_publication_copies) {
    const intent = intents.get(copy.operation_id), role = copy.artifact;
    if (!intent || !["main", "thumb"].includes(role) || !/^data-[a-f0-9]{16}$/.test(copy.staging_name) || copy.executor_epoch !== intent.executor_epoch || copy.sha256 !== intent[`${role}_sha256`]) fail();
    const seal = seals.get(intent.seal_id)!;
    if (copy.bytes !== seal[`${role}_bytes`]) fail();
    const name = `publication/${copy.operation_id}/${role}/${copy.staging_name}`;
    if (!present.has(name) && intent.state === "committed" && !required.includes(copy.operation_id)) continue;
    add({ path: name, sha256: copy.sha256, bytes: copy.bytes, dev: copy.copy_dev, ino: copy.copy_ino, birthNs: copy.copy_birth_ns });
  }
  if ([...dirs].some(dir => !allowedDirs.has(dir))) fail();
  const actual = [...present].filter(name => name !== "database.sqlite").sort();
  if (!same(actual, [...expected.keys()].sort())) fail();
  return [...expected.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function inspect(root: Source, original: boolean, required: string[] = []) {
  const listing = await inventory(root);
  if (!listing.files.includes("database.sqlite") || listing.files.some(name => name.startsWith("database.sqlite-"))) fail();
  const databasePath = sourcePath(root, "database.sqlite");
  const dbInfo = await lstat(databasePath);
  if (dbInfo.size > MAX_DB) fail();
  const header = await open(databasePath, "r");
  try {
    const bytes = Buffer.alloc(20); await header.read(bytes, 0, bytes.length, 0);
    // WAL snapshots need a separate capture protocol; never let read-only SQLite create sidecars here.
    if (bytes[18] !== 1 || bytes[19] !== 1) fail();
  } finally { await header.close(); }
  const database = await ownedPhotoArtifactProof(databasePath);
  const records = authority(databasePath);
  const bound = bindings(records, new Set(listing.files), new Set(listing.directories), required);
  for (const id of required) {
    if (!bound.some(b => b.path.startsWith(`operations/${id}/`))) fail();
    // A retained committed publication must have both recorded anchors, not just a private byte copy.
    const op = records.photo_operations.find(o => o.id === id)!;
    if (op.state === "committed" && ["main", "thumb"].some(role => !bound.some(b => b.path.startsWith(`publication/${id}/${role}/`)))) fail();
  }
  const entries: Entry[] = [{ path: "database.sqlite", sha256: database.sha256, bytes: database.bytes }];
  let total = database.bytes;
  for (const b of bound) {
    const file = sourcePath(root, b.path), info = await lstat(file);
    if (info.size !== b.bytes || (total += info.size) > MAX_TOTAL) fail();
    const proof = await ownedPhotoArtifactProof(file, original && b.dev.startsWith("pfs1:"));
    if (proof.sha256 !== b.sha256 || proof.bytes !== b.bytes) fail();
    if (original && (proof.dev !== b.dev || proof.ino !== b.ino || (b.birthNs && String((await lstat(file, { bigint: true })).birthtimeNs) !== b.birthNs))) fail();
    entries.push({ path: b.path, sha256: proof.sha256, bytes: proof.bytes });
  }
  if (!same(listing, await inventory(root)) || !same(database, await ownedPhotoArtifactProof(databasePath))) fail();
  return { entries, bound, listing };
}

async function copyExclusive(source: string, destination: string, entry: Entry) {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const input = await open(source, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
  let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    output = await open(destination, "wx", 0o600);
    const buffer = Buffer.alloc(64 * 1024), digest = createHash("sha256"); let bytes = 0;
    while (true) {
      const read = await input.read(buffer, 0, Math.min(buffer.length, entry.bytes - bytes + 1), null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead; if (bytes > entry.bytes) fail();
      digest.update(buffer.subarray(0, read.bytesRead));
      let written = 0;
      while (written < read.bytesRead) { const result = await output.write(buffer, written, read.bytesRead - written); if (!result.bytesWritten) fail(); written += result.bytesWritten; }
    }
    if (bytes !== entry.bytes || digest.digest("hex") !== entry.sha256) fail();
    await output.sync();
  } finally { await input.close(); await output?.close(); }
}

export function createPrivatePhotoOfflineBackupUseCase() {
  return {
    async execute(workspace: string, recoveryPointId: string) {
      const root = await disposableWorkspace(workspace);
      if (!component(recoveryPointId)) fail();
      const source = await directory(path.join(root, "source"));
      const destination = path.join(root, "bundle");
      return capture(source, destination, recoveryPointId);
    },
  };
}

async function capture(source: Source, destination: string, recoveryPointId: string, operatorPrerequisite?: Manifest["operatorPrerequisite"]) {
      const required = operatorPrerequisite?.requiredRetainedOperationIds ?? [];
      const before = await inspect(source, true, required);
      // Exclusive destination. Failures retain partial evidence; no automatic removal or overwrite.
      await mkdir(destination, { mode: 0o700 });
      await mkdir(path.join(destination, "payload"), { mode: 0o700 });
      for (const dir of before.listing.directories) await mkdir(path.join(destination, "payload", dir), { recursive: true, mode: 0o700 });
      for (const entry of before.entries) await copyExclusive(sourcePath(source, entry.path), path.join(destination, "payload", entry.path), entry);
      if (!same(before, await inspect(source, true, required))) fail();
      const recovered = await inspect(path.join(destination, "payload"), false, required);
      if (!same(before.entries, recovered.entries) || !same(before.bound, recovered.bound)) fail();
      const manifest: Manifest = { version: 1, scope: operatorPrerequisite ? "owner-operated-cold-evidence-only" : "disposable-offline-evidence-only", recoveryPointId, entries: before.entries, originalBindings: before.bound, ...(operatorPrerequisite ? { operatorPrerequisite } : {}) };
      const content = `${JSON.stringify(manifest)}\n`;
      if (Buffer.byteLength(content) > MAX_MANIFEST) fail();
      await writeFile(path.join(destination, "manifest.json"), content, { flag: "wx", mode: 0o600 });
      return { manifestSha256: hash(content), files: before.entries.length, scope: manifest.scope };
}

/** Check existing local protection only. No chmod/ACL/security settings or encryption platform changes. */
async function privateDestination(directoryPath: string) {
  const root = await directory(directoryPath), st = await lstat(root);
  if (typeof process.getuid !== "function" || st.uid !== process.getuid() || (st.mode & 0o077) !== 0) throw new Error("PRIVATE_BACKUP_DESTINATION_CONFIDENTIALITY_UNVERIFIED");
  return root;
}

/** Owner-operated cold input only. Evidence references are audit prerequisites, NEVER machine proof of quiescence/encryption. */
export async function capturePrivatePhotoColdBackup(request: ColdBackupRequest) {
  if (!request || !component(request.recoveryPointId) || !component(request.quiescenceEvidenceRef) || !component(request.confidentialityEvidenceRef) || !Array.isArray(request.requiredRetainedOperationIds) || !request.source) fail();
  for (const value of [request.destination, request.source.database, request.source.operations, request.source.publication]) if (typeof value !== "string" || !path.isAbsolute(value)) fail();
  const parent = await privateDestination(path.dirname(request.destination));
  const destination = path.join(parent, path.basename(request.destination));
  const source = { database: path.resolve(request.source.database), operations: await directory(request.source.operations), publication: await directory(request.source.publication) };
  const overlaps = (a: string, b: string) => { const r = path.relative(comparePath(a), comparePath(b)); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
  for (const input of [source.operations, source.publication, source.database]) if (overlaps(input, destination) || overlaps(destination, input)) fail();
  const result = await capture(source, destination, request.recoveryPointId, { quiescenceEvidenceRef: request.quiescenceEvidenceRef, confidentialityEvidenceRef: request.confidentialityEvidenceRef, requiredRetainedOperationIds: request.requiredRetainedOperationIds });
  return { ...result, sourcePrerequisite: "operator-evidence-not-machine-proven" as const, runnableRecovery: false as const };
}

/** External expected digest is mandatory; no self-authenticating mutable manifest. No live materialization. */
export async function verifyPrivatePhotoOfflineBundle(workspace: string, expectedManifestSha256: string) {
  const root = await disposableWorkspace(workspace), bundle = await directory(path.join(root, "bundle"));
  return verifyBundle(bundle, expectedManifestSha256);
}

export async function verifyPrivatePhotoColdBundle(bundlePath: string, expectedManifestSha256: string) {
  return verifyBundle(await privateDestination(bundlePath), expectedManifestSha256);
}

async function verifyBundle(bundle: string, expectedManifestSha256: string) {
  if (!/^[a-f0-9]{64}$/.test(expectedManifestSha256)) fail();
  const name = path.join(bundle, "manifest.json"), info = await lstat(name);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST) fail();
  const handle = await open(name, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
  let bytes: Buffer;
  try {
    const buffer = Buffer.alloc(MAX_MANIFEST + 1); let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, buffer.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > MAX_MANIFEST || !(await handle.stat()).isFile()) fail();
    bytes = buffer.subarray(0, size);
  } finally { await handle.close(); }
  if (hash(bytes) !== expectedManifestSha256) fail();
  const manifest = JSON.parse(bytes.toString("utf8")) as Manifest;
  if (manifest.version !== 1 || !["disposable-offline-evidence-only", "owner-operated-cold-evidence-only"].includes(manifest.scope) || !component(manifest.recoveryPointId)) fail();
  if (manifest.scope === "owner-operated-cold-evidence-only" && (!manifest.operatorPrerequisite || !component(manifest.operatorPrerequisite.quiescenceEvidenceRef) || !component(manifest.operatorPrerequisite.confidentialityEvidenceRef) || !Array.isArray(manifest.operatorPrerequisite.requiredRetainedOperationIds))) fail();
  const recovered = await inspect(await directory(path.join(bundle, "payload")), false, manifest.operatorPrerequisite?.requiredRetainedOperationIds);
  if (!same(manifest.entries, recovered.entries) || !same(manifest.originalBindings, recovered.bound)) fail();
  return { integrity: "ok" as const, files: recovered.entries.length, runnableRecovery: false as const };
}
