/** Single CI-only supported-platform acceptance. No mocks, runtime DB import, network or publication replay. */
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const digest = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function insert(db: Database.Database, table: string, row: Record<string, unknown>) {
  db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
}

async function prepare(root: string) {
  const source = path.join(root, "source"), canonical = path.join(source, "canonical");
  fs.mkdirSync(source, { mode: 0o700 }); fs.mkdirSync(canonical, { mode: 0o700 });
  const writerDatabase = path.join(source, "writer.sqlite");
  // Set disposable process configuration before loading the candidate's BUILT real owners/storage modules.
  Object.assign(process.env, { DATABASE_DRIVER: "sqlite", DATABASE_URL: writerDatabase, PRODUCT_PHOTO_DIR: canonical, PRODUCT_PHOTO_DISK_STAGING_ENABLED: "true", PHOTO_OWNERSHIP_FENCING_ENABLED: "true" });
  const built = (name: string) => require(path.resolve("apps/api/dist", name));
  const { ensureSchema } = built("db/migrate.js") as typeof import("../../src/db/migrate");
  const { drizzle } = require("drizzle-orm/better-sqlite3") as typeof import("drizzle-orm/better-sqlite3");
  const { uploadFencedProductPhoto } = built("services/w2FencedProductPhotoOwner.js") as typeof import("../../src/services/w2FencedProductPhotoOwner");
  const { finalizeAiIntakePhotos } = built("services/aiIntakePhotoFinalization.js") as typeof import("../../src/services/aiIntakePhotoFinalization");
  const { digestW2StagedInput } = built("services/w2StagedInputDigest.js") as typeof import("../../src/services/w2StagedInputDigest");
  const { photoPreparationConfinementConfig } = built("services/photoPreparationConfinement.js") as typeof import("../../src/services/photoPreparationConfinement");
  const { ProductStatus, ProductType, AiProductIntakeStatus } = require("@noctella/shared") as typeof import("@noctella/shared");
  const sharp = require("sharp") as typeof import("sharp");
  assert.equal(photoPreparationConfinementConfig().mode, "confined");
  const db = new Database(writerDatabase);
  try {
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL"); // acceptance must normalize a WAL-configured source using the documented method
    ensureSchema(db);
    db.exec("CREATE TABLE cold_acceptance_sentinel (value TEXT); INSERT INTO cold_acceptance_sentinel VALUES ('synthetic-only')");
    insert(db, "categories", { id: "cold-category", name: "Synthetic", slug: "cold-category" });
    for (const id of ["cold-w2-product", "cold-w4-product"]) insert(db, "products", { id, sku: id, title: "Synthetic", slug: id, type: ProductType.UniqueItem, status: ProductStatus.Draft, category_id: "cold-category" });
    const runtimeDb = drizzle(db, { schema: built("db/schema.js") as typeof import("../../src/db/schema") });
    const bytes = await sharp({ create: { width: 120, height: 80, channels: 3, background: "#705030" } }).jpeg().toBuffer();
    const workDir = path.join(root, "w2-input"); fs.mkdirSync(workDir, { mode: 0o700 });
    const inputPath = path.join(workDir, "input"); fs.writeFileSync(inputPath, bytes, { flag: "wx", mode: 0o600 });
    const file = { path: inputPath, workDir, size: bytes.length, mimetype: "image/jpeg", signal: new AbortController().signal };
    await uploadFencedProductPhoto(runtimeDb, { productId: "cold-w2-product", actorId: "cold-admin", operationToken: "cold-w2-operation-0001", sha256: await digestW2StagedInput(file, 10 * 1024 * 1024), altText: "", file }, { driver: "sqlite", canonicalRoot: canonical });
    insert(db, "ai_product_intakes", { id: "cold-intake", status: AiProductIntakeStatus.Applied, created_by_admin_user_id: "cold-admin", result_product_id: "cold-w4-product", applied_at: new Date().toISOString(), applied_by_admin_user_id: "cold-admin" });
    insert(db, "ai_intake_photos", { id: "cold-staged-photo", intake_id: "cold-intake", storage_key: "synthetic-source.jpg", original_filename: "synthetic.jpg", created_by_admin_user_id: "cold-admin", created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    const finalized = await finalizeAiIntakePhotos(runtimeDb, "cold-intake", {}, "cold-admin", { readStagedPhotoBytes: async () => bytes, writeDeterministicPhoto: async () => { throw new Error("Unconfined W4 writer must not run"); } }, { driver: "sqlite", canonicalRoot: canonical });
    assert.equal(finalized.created, true);
    const operations = db.prepare("SELECT id, kind, state FROM photo_operations ORDER BY kind").all() as Array<{ id: string; kind: string; state: string }>;
    assert.deepEqual(operations.map(o => [o.kind, o.state]), [["ai_finalize", "committed"], ["product_upload", "committed"]]);
    assert.equal(db.prepare("SELECT count(*) FROM photo_publication_intents WHERE state='committed'").pluck().get(), 2);
    assert.equal(db.prepare("SELECT count(*) FROM photo_publication_copies").pluck().get(), 4);
    assert.equal(db.prepare("SELECT count(*) FROM product_photos").pluck().get(), 2);
    fs.writeFileSync(path.join(root, "required-operations.json"), JSON.stringify(operations.map(o => o.id)), { flag: "wx", mode: 0o600 });
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally { db.close(); } // every file descriptor above is closed; writer exits before controller captures
}

function child(script: string, args: string[], succeeds = true, typescript = false) {
  const result = spawnSync(process.execPath, [...(typescript ? ["--import", "tsx"] : []), script, ...args], { encoding: "utf8", timeout: 180_000, maxBuffer: 1024 * 1024 });
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
  const writer = child(__filename, ["prepare", root], true, true);
  assert.equal(writer.signal, null); // synchronous child completion proves this sole fixture writer has ended
  const source = path.join(root, "source"), dbPath = path.join(source, "database.sqlite");
  const cli = path.resolve("apps/api/dist/scripts/privatePhotoColdBackup.js");
  assert.deepEqual([...fs.readFileSync(path.join(source, "writer.sqlite")).subarray(18, 20)], [2, 2]);
  // Same built command as the operator procedure, AFTER every real owner/preparation writer has exited.
  const snapshot = JSON.parse(child(cli, ["snapshot", path.join(source, "writer.sqlite"), dbPath]).stdout);
  assert.equal(snapshot.journalMode, "delete"); assert.equal(snapshot.sidecars, false);
  assert.deepEqual([...fs.readFileSync(dbPath).subarray(18, 20)], [1, 1]);
  for (const suffix of ["-wal", "-shm", "-journal"]) assert.equal(fs.existsSync(dbPath + suffix), false);
  const sourceDigest = digest(dbPath);
  const destinationParent = path.join(root, "private-destination");
  fs.mkdirSync(destinationParent, { mode: 0o700 });
  fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const request = { source: { database: dbPath, operations: path.join(source, ".product-photo-operations"), publication: path.join(source, ".product-photo-publication") }, destination: path.join(destinationParent, "bundle"), recoveryPointId: "linux-cold-1", quiescenceEvidenceRef: "real-owner-and-confined-workers-exited", confidentialityEvidenceRef: "synthetic-local-posix-only", requiredRetainedOperationIds: JSON.parse(fs.readFileSync(path.join(root, "required-operations.json"), "utf8")) as string[] };
  const requestPath = path.join(root, "request.json");
  fs.writeFileSync(requestPath, JSON.stringify(request), { flag: "wx", mode: 0o600 });
  const captured = JSON.parse(child(cli, ["capture", requestPath]).stdout);
  assert.equal(captured.files, 9);
  assert.equal(captured.scope, "owner-operated-cold-evidence-only");
  assert.equal(captured.sourcePrerequisite, "operator-evidence-not-machine-proven");
  assert.equal(captured.runnableRecovery, false);
  assert.match(captured.manifestSha256, /^[a-f0-9]{64}$/);
  // Retain the CLI-returned digest outside the bundle; verification never derives its expected digest from that bundle.
  const digestPath = path.join(evidence, "independent-manifest.sha256");
  fs.writeFileSync(digestPath, captured.manifestSha256 + "\n", { flag: "wx", mode: 0o600 });
  const expected = fs.readFileSync(digestPath, "utf8").trim();
  const verified = JSON.parse(child(cli, ["verify", request.destination, expected]).stdout);
  assert.deepEqual(verified, { integrity: "ok", files: 9, runnableRecovery: false });
  const recoveredDb = new Database(path.join(request.destination, "payload/database.sqlite"), { readonly: true, fileMustExist: true });
  try {
    assert.equal(recoveredDb.prepare("SELECT value FROM cold_acceptance_sentinel").pluck().get(), "synthetic-only");
    assert.equal(recoveredDb.prepare("SELECT count(*) FROM photo_publication_intents WHERE state='committed'").pluck().get(), 2);
    assert.equal(recoveredDb.prepare("SELECT count(*) FROM photo_publication_copies").pluck().get(), 4);
  } finally { recoveredDb.close(); }
  const coldDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    for (const operation of coldDb.prepare("SELECT * FROM photo_operations").all() as Record<string, any>[]) for (const role of ["main", "thumb"]) {
      const original = path.join(request.source.operations, operation.id, String(operation.generation), role + ".webp");
      const materialized = path.join(request.destination, "payload/operations", operation.id, String(operation.generation), role + ".webp");
      const copy = coldDb.prepare("SELECT * FROM photo_publication_copies WHERE operation_id=? AND artifact=?").get(operation.id, role) as Record<string, any>;
      const anchor = path.join(request.source.publication, operation.id, role, copy.staging_name);
      assert.match(copy.copy_dev, /^pfs1:[a-f0-9]{32}:[1-9][0-9]*$/);
      assert.equal(String(fs.statSync(anchor).ino), copy.copy_ino);
      assert.equal(fs.statSync(anchor).ino, fs.statSync(path.join(source, "canonical", operation[role + "_key"])).ino);
      assert.equal(fs.statSync(anchor).nlink, 2);
      assert.notEqual(fs.statSync(original).ino, fs.statSync(anchor).ino);
      assert.notEqual(fs.statSync(original).ino, fs.statSync(materialized).ino);
      assert.equal(digest(original), digest(materialized));
    }
  } finally { coldDb.close(); }
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
  fs.writeFileSync(path.join(request.destination, "payload/operations", request.requiredRetainedOperationIds[0], "1/main.webp"), "disposable-corruption");
  child(cli, ["verify", request.destination, expected], false);
  fs.writeFileSync(path.join(evidence, "acceptance.json"), JSON.stringify({ sourceSha: process.env.GATE5_SOURCE_SHA, platform: process.platform, identity: "real-confined-W2-and-W4-publisher-pfs1", writer: "real-owners-and-preparation-children-ended-before-snapshot", snapshot, capture: captured, verify: verified, refusals: ["public-posix-destination", "wrong-independent-digest", "corrupted-materialized-artifact"], limits: "synthetic ext4/POSIX only; no production confidentiality, encryption, capacity or replay acceptance" }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log("Gate 5 Linux cold capture/verify and scoped refusals PASS");
}

const [mode, root, evidence] = process.argv.slice(2);
if (mode === "prepare" && root) void prepare(root).catch(error => { console.error(error); process.exitCode = 1; });
else if (mode === "accept" && root && evidence) void acceptance(root, evidence).catch(error => { console.error(error); process.exitCode = 1; });
else throw new Error("Expected prepare <root> or accept <root> <independent-evidence-directory>");
