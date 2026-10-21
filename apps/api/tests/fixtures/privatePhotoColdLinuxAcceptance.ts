/** Single CI-only supported-platform acceptance. No mocks, runtime DB import, network or publication replay. */
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ownedPhotoArtifactProof } from "../../src/services/ownedPhotoArtifactProof";

const digest = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function insert(db: Database.Database, table: string, row: Record<string, unknown>) {
  db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
}

async function prepare(root: string) {
  const source = path.join(root, "source"), canonical = path.join(root, "canonical");
  fs.mkdirSync(source, { mode: 0o700 }); fs.mkdirSync(canonical, { mode: 0o700 });
  const db = new Database(path.join(source, "database.sqlite"));
  try {
    db.pragma("foreign_keys = ON");
    db.exec(fs.readFileSync("apps/api/src/db/schema.sql", "utf8"));
    db.exec("CREATE TABLE cold_acceptance_sentinel (value TEXT); INSERT INTO cold_acceptance_sentinel VALUES ('synthetic-only')");
    insert(db, "photo_operations", { id: "cold-op", kind: "product_upload", subject_type: "acceptance", subject_id: "cold-subject", target_photo_id: "cold-photo", main_key: "main.webp", thumb_key: "thumb.webp", input_sha256: "a".repeat(64), generation: 1, owner: "fixture-owner", nonce: "fixture-nonce", state: "committed", lease_until_ms: 1, seal_id: "cold-seal", committed_photo_id: "cold-photo", created_ms: 1, updated_ms: 1 });
    insert(db, "photo_operation_generations", { operation_id: "cold-op", generation: 1, owner: "fixture-owner", nonce: "fixture-nonce", state: "committed", created_ms: 1, updated_ms: 1 });
    const seal: Record<string, unknown> = { id: "cold-seal", operation_id: "cold-op", generation: 1, relative_path: "cold-op/1", created_ms: 1 };
    const copies: Record<string, unknown>[] = [];
    let storageIdentity = "";
    for (const role of ["main", "thumb"]) {
      const privateFile = path.join(source, "operations/cold-op/1", role + ".webp");
      const anchor = path.join(source, "publication/cold-op", role, "data-0123456789abcdef");
      fs.mkdirSync(path.dirname(privateFile), { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.dirname(anchor), { recursive: true, mode: 0o700 });
      // Opaque synthetic backup payload: no encoder/recipe regression is repeated here.
      const bytes = Buffer.from(`synthetic-cold-${role}`);
      fs.writeFileSync(privateFile, bytes, { flag: "wx", mode: 0o600 });
      fs.writeFileSync(anchor, bytes, { flag: "wx", mode: 0o600 });
      fs.linkSync(anchor, path.join(canonical, role + ".webp"));
      const original = await ownedPhotoArtifactProof(privateFile, true), published = await ownedPhotoArtifactProof(anchor, true);
      assert.match(original.dev, /^pfs1:[a-f0-9]{32}:[1-9][0-9]*$/);
      assert.notEqual(original.ino, published.ino);
      assert.equal(fs.statSync(anchor).nlink, 2);
      storageIdentity = original.dev;
      for (const field of ["sha256", "bytes", "dev", "ino"] as const) seal[`${role}_${field}`] = original[field];
      copies.push({ operation_id: "cold-op", artifact: role, executor_epoch: 1, staging_name: path.basename(anchor), copy_dev: published.dev, copy_ino: published.ino, copy_birth_ns: String(fs.statSync(anchor, { bigint: true }).birthtimeNs), sha256: published.sha256, bytes: published.bytes, recorded_ms: 1 });
    }
    insert(db, "photo_storage_roots", { id: "fixture-root", identity: storageIdentity, created_ms: 1 });
    insert(db, "photo_operation_artifacts", seal);
    const intent: Record<string, unknown> = { operation_id: "cold-op", generation: 1, owner: "fixture-owner", nonce: "fixture-nonce", seal_id: "cold-seal", main_key: "main.webp", thumb_key: "thumb.webp", executor_epoch: 1, executor_token: "historical-fixture-token", executor_identity: "historical-fixture-only-not-exit-authority", state: "committed", created_ms: 1, updated_ms: 1 };
    for (const role of ["main", "thumb"]) for (const field of ["sha256", "dev", "ino"]) intent[`${role}_${field}`] = seal[`${role}_${field}`];
    insert(db, "photo_publication_intents", intent);
    for (const copy of copies) insert(db, "photo_publication_copies", copy);
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally { db.close(); } // every file descriptor above is closed; writer exits before controller captures
}

function child(script: string, args: string[], succeeds = true) {
  const result = spawnSync(process.execPath, ["--import", "tsx", script, ...args], { encoding: "utf8", timeout: 90_000, maxBuffer: 1024 * 1024 });
  assert.ifError(result.error);
  if (succeeds) assert.equal(result.status, 0, result.stderr);
  else { assert.notEqual(result.status, null); assert.notEqual(result.status, 0, "refusal expected"); }
  return result;
}

async function acceptance(root: string, evidence: string) {
  assert.equal(process.platform, "linux");
  assert.ok(path.isAbsolute(root) && path.isAbsolute(evidence));
  assert.equal(fs.statSync(root).uid, process.getuid!());
  assert.equal(fs.statSync(root).mode & 0o077, 0);
  const writer = child(__filename, ["prepare", root]);
  assert.equal(writer.signal, null); // synchronous child completion proves this sole fixture writer has ended
  const source = path.join(root, "source"), dbPath = path.join(source, "database.sqlite");
  const sourceDigest = digest(dbPath);
  const destinationParent = path.join(root, "private-destination");
  fs.mkdirSync(destinationParent, { mode: 0o700 });
  fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const request = { source: { database: dbPath, operations: path.join(source, "operations"), publication: path.join(source, "publication") }, destination: path.join(destinationParent, "bundle"), recoveryPointId: "linux-cold-1", quiescenceEvidenceRef: "sole-fixture-writer-exited", confidentialityEvidenceRef: "synthetic-local-posix-only", requiredRetainedOperationIds: ["cold-op"] };
  const requestPath = path.join(root, "request.json");
  fs.writeFileSync(requestPath, JSON.stringify(request), { flag: "wx", mode: 0o600 });
  const cli = path.resolve("apps/api/src/scripts/privatePhotoColdBackup.ts");
  const captured = JSON.parse(child(cli, ["capture", requestPath]).stdout);
  assert.equal(captured.files, 5);
  assert.equal(captured.scope, "owner-operated-cold-evidence-only");
  assert.equal(captured.sourcePrerequisite, "operator-evidence-not-machine-proven");
  assert.equal(captured.runnableRecovery, false);
  assert.match(captured.manifestSha256, /^[a-f0-9]{64}$/);
  // Retain the CLI-returned digest outside the bundle; verification never derives its expected digest from that bundle.
  const digestPath = path.join(evidence, "independent-manifest.sha256");
  fs.writeFileSync(digestPath, captured.manifestSha256 + "\n", { flag: "wx", mode: 0o600 });
  const expected = fs.readFileSync(digestPath, "utf8").trim();
  const verified = JSON.parse(child(cli, ["verify", request.destination, expected]).stdout);
  assert.deepEqual(verified, { integrity: "ok", files: 5, runnableRecovery: false });
  const recoveredDb = new Database(path.join(request.destination, "payload/database.sqlite"), { readonly: true, fileMustExist: true });
  try {
    assert.equal(recoveredDb.prepare("SELECT value FROM cold_acceptance_sentinel").pluck().get(), "synthetic-only");
    assert.equal(recoveredDb.prepare("SELECT executor_token FROM photo_publication_intents").pluck().get(), "historical-fixture-token");
  } finally { recoveredDb.close(); }
  for (const role of ["main", "thumb"]) {
    const original = path.join(source, "operations/cold-op/1", role + ".webp");
    const materialized = path.join(request.destination, "payload/operations/cold-op/1", role + ".webp");
    assert.notEqual(fs.statSync(original).ino, fs.statSync(materialized).ino);
    assert.equal(digest(original), digest(materialized));
  }
  assert.equal(digest(dbPath), sourceDigest);
  assert.equal(fs.statSync(request.destination).mode & 0o077, 0);
  // Real POSIX refusal: this newly created synthetic directory deliberately permits other users to traverse/read.
  const publicParent = path.join(root, "public-destination"); fs.mkdirSync(publicParent, { mode: 0o755 });
  assert.notEqual(fs.statSync(publicParent).mode & 0o077, 0);
  const publicRequest = path.join(root, "public-request.json");
  fs.writeFileSync(publicRequest, JSON.stringify({ ...request, destination: path.join(publicParent, "must-not-exist") }), { flag: "wx", mode: 0o600 });
  child(cli, ["capture", publicRequest], false);
  assert.equal(fs.existsSync(path.join(publicParent, "must-not-exist")), false);
  const wrongDigest = (expected[0] === "0" ? "1" : "0") + expected.slice(1);
  child(cli, ["verify", request.destination, wrongDigest], false);
  fs.writeFileSync(path.join(request.destination, "payload/operations/cold-op/1/main.webp"), "disposable-corruption");
  child(cli, ["verify", request.destination, expected], false);
  fs.writeFileSync(path.join(evidence, "acceptance.json"), JSON.stringify({ sourceSha: process.env.GATE5_SOURCE_SHA, platform: process.platform, identity: "real-pfs1-original-inodes", writer: "sole-child-exited-before-capture", capture: captured, verify: verified, refusals: ["public-posix-destination", "wrong-independent-digest", "corrupted-materialized-artifact"], limits: "synthetic ext4/POSIX only; no production confidentiality, encryption, capacity or replay acceptance" }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log("Gate 5 Linux cold capture/verify and scoped refusals PASS");
}

const [mode, root, evidence] = process.argv.slice(2);
if (mode === "prepare" && root) void prepare(root).catch(error => { console.error(error); process.exitCode = 1; });
else if (mode === "accept" && root && evidence) void acceptance(root, evidence).catch(error => { console.error(error); process.exitCode = 1; });
else throw new Error("Expected prepare <root> or accept <root> <independent-evidence-directory>");
