/**
 * 4C (#424): authorized canonical deletion for W8 under ownership fencing.
 *
 * Deletes the two canonical files of ONE deleted product photo only when, inside ONE ownership transaction that holds
 * the photo_operations row lock (PostgreSQL FOR UPDATE, SQLite BEGIN IMMEDIATE via inOwnershipTransaction):
 * - the photo's operation (target_photo_id) is 'committed' for exactly this photo, and its publication intent is
 *   'committed' for the same keys with both publisher-owned copy records;
 * - no product_photos row, other operation or intent, or other media reference (product_images, category/collection
 *   images, order-item snapshots, social media and prepared images, SQLite media plans) names the photo or a key;
 * - every existing canonical name is exactly its recorded copy inode (device, ino, birth time) holding the sealed bytes.
 * Both names are verified before either is unlinked; a name already absent needs no mutation. Anything else retains
 * every file and returns a disposition. Database rows, private generation, staging and backup data are never touched.
 *
 * Not an automatic sweep: one call per explicit photo deletion event. Age or pathname existence grants no authority.
 */
import fs from "node:fs";
import { sql, type SQL } from "drizzle-orm";
import type { DbClient } from "../db/client";
import { inOwnershipTransaction, type OwnershipDriver, type Rows } from "./photoOperationAuthority";
import { exactPositiveInteger } from "./photoPublicationIntents";
import { hashFd } from "./photoCopyPublisher";
import { matchesPhotoDevice } from "./photoPersistentIdentity";
import { productPhotoStorageSafety } from "./productPhotoStorageWorkflow";

export type CanonicalDeletionRetention =
  | "PHOTO_DELETE_OWNERSHIP_UNKNOWN"
  | "PHOTO_DELETE_OPERATION_UNRESOLVED"
  | "PHOTO_DELETE_KEY_REFERENCED"
  | "PHOTO_DELETE_FOREIGN_FILE"
  | "PHOTO_DELETE_REFERENCES_UNSERIALIZED";
export type CanonicalDeletionDisposition = { kind: "deleted"; removed: number } | { kind: "retained"; code: CanonicalDeletionRetention };

interface RecordedCopy { dev: string; ino: string; birthNs: string; sha256: string; bytes: number }

const rowLock = (driver: OwnershipDriver) => sql.raw(driver === "postgres" ? " FOR UPDATE" : "");
const contains = (column: string, value: string) => sql`${sql.raw(column)} LIKE ${`%${value}%`}`;

/** Any current reference keeps the files. Substring matches over-retain by design (URLs with prefixes or suffixes). */
function referenceChecks(driver: OwnershipDriver, operationId: string, photoId: string, keys: [string, string]): SQL[] {
  const anyKey = (column: string) => sql`(${contains(column, keys[0])} OR ${contains(column, keys[1])})`;
  const checks = [
    sql`SELECT 1 AS hit FROM product_photos WHERE id = ${photoId} OR ${anyKey("storage_key")} OR ${anyKey("thumbnail_storage_key")} OR ${anyKey("filename")} OR ${anyKey("url")} OR ${anyKey("thumbnail_url")} LIMIT 1`,
    sql`SELECT 1 AS hit FROM product_images WHERE ${anyKey("url")} LIMIT 1`,
    sql`SELECT 1 AS hit FROM categories WHERE ${anyKey("display_image_url")} LIMIT 1`,
    sql`SELECT 1 AS hit FROM collections WHERE ${anyKey("cover_image_url")} LIMIT 1`,
    sql`SELECT 1 AS hit FROM order_items WHERE ${anyKey("product_image_url")} LIMIT 1`,
    sql`SELECT 1 AS hit FROM social_content_media WHERE photo_id = ${photoId} LIMIT 1`,
    sql`SELECT 1 AS hit FROM social_prepared_images WHERE source_photo_id = ${photoId} LIMIT 1`,
    sql`SELECT 1 AS hit FROM photo_operations WHERE id <> ${operationId} AND (main_key IN (${keys[0]}, ${keys[1]}) OR thumb_key IN (${keys[0]}, ${keys[1]})) LIMIT 1`,
    sql`SELECT 1 AS hit FROM photo_publication_intents WHERE operation_id <> ${operationId} AND (main_key IN (${keys[0]}, ${keys[1]}) OR thumb_key IN (${keys[0]}, ${keys[1]})) LIMIT 1`,
  ];
  // Media planning is SQLite-only (no PostgreSQL migration or repository).
  if (driver === "sqlite") checks.push(sql`SELECT 1 AS hit FROM media_plan_items WHERE hero_photo_id = ${photoId} OR ${contains("photo_ids_json", photoId)} LIMIT 1`);
  return checks;
}

/** "absent" | "match" | "foreign": only the exact recorded copy inode with the sealed bytes is deletable. */
function inspectCanonical(file: string, copy: RecordedCopy): "absent" | "match" | "foreign" {
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); }
  catch (e: any) { if (e?.code === "ENOENT") return "absent"; if (e?.code === "ELOOP") return "foreign"; throw e; }
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(file, { bigint: true });
    if (!st.isFile() || !named.isFile() || named.dev !== st.dev || named.ino !== st.ino) return "foreign";
    if (!matchesPhotoDevice(fd, st, copy.dev) || String(st.ino) !== copy.ino || String(st.birthtimeNs) !== copy.birthNs) return "foreign";
    const current = hashFd(fd);
    return current.sha256 === copy.sha256 && current.bytes === copy.bytes ? "match" : "foreign";
  } finally { fs.closeSync(fd); }
}

export function* authorizedCanonicalDeletionSteps(driver: OwnershipDriver, canonicalRoot: string, photoId: string): Generator<SQL, CanonicalDeletionDisposition, Rows> {
  const retained = (code: CanonicalDeletionRetention): CanonicalDeletionDisposition => ({ kind: "retained", code });
  const [op] = yield sql`SELECT id, state, committed_photo_id, main_key, thumb_key FROM photo_operations WHERE target_photo_id = ${photoId}${rowLock(driver)}`;
  if (!op) return retained("PHOTO_DELETE_OWNERSHIP_UNKNOWN");
  if (op.state !== "committed" || op.committed_photo_id !== photoId) return retained("PHOTO_DELETE_OPERATION_UNRESOLVED");
  const [intent] = yield sql`SELECT state, main_key, thumb_key FROM photo_publication_intents WHERE operation_id = ${op.id}${rowLock(driver)}`;
  if (!intent) return retained("PHOTO_DELETE_OWNERSHIP_UNKNOWN");
  if (intent.state !== "committed") return retained("PHOTO_DELETE_OPERATION_UNRESOLVED");
  if (intent.main_key !== op.main_key || intent.thumb_key !== op.thumb_key) return retained("PHOTO_DELETE_OWNERSHIP_UNKNOWN");
  const copyRows = yield sql`SELECT artifact, copy_dev, copy_ino, copy_birth_ns, sha256, bytes FROM photo_publication_copies WHERE operation_id = ${op.id}`;
  const copies = new Map(copyRows.map((r) => [r.artifact, { dev: String(r.copy_dev), ino: String(r.copy_ino), birthNs: String(r.copy_birth_ns), sha256: String(r.sha256), bytes: exactPositiveInteger(r.bytes) } as RecordedCopy]));
  const main = copies.get("main"), thumb = copies.get("thumb");
  if (!main || !thumb) return retained("PHOTO_DELETE_OWNERSHIP_UNKNOWN");
  const keys: [string, string] = [String(op.main_key), String(op.thumb_key)];
  for (const check of referenceChecks(driver, String(op.id), photoId, keys)) {
    if ((yield check).length > 0) return retained("PHOTO_DELETE_KEY_REFERENCED");
  }
  // Still under the lock: verify both names, then unlink. No await between verification and unlink.
  const targets = [{ file: productPhotoStorageSafety.safeJoin(canonicalRoot, keys[0]), copy: main }, { file: productPhotoStorageSafety.safeJoin(canonicalRoot, keys[1]), copy: thumb }];
  const states = targets.map((t) => inspectCanonical(t.file, t.copy));
  if (states.includes("foreign")) return retained("PHOTO_DELETE_FOREIGN_FILE");
  let removed = 0;
  for (let i = 0; i < targets.length; i += 1) {
    if (states[i] !== "match") continue;
    try { fs.unlinkSync(targets[i].file); removed += 1; } catch (e: any) { if (e?.code !== "ENOENT") throw e; }
  }
  return { kind: "deleted", removed };
}

/**
 * PostgreSQL retains: under READ COMMITTED, order creation reads the primary-photo URL before any lock this deleter
 * takes (use-cases/order/useCases.ts validateProductReferences), so a concurrent order could commit a snapshot of a
 * deleted file. On SQLite the order read and insert run in one synchronous transaction that cannot interleave with this
 * BEGIN IMMEDIATE deletion, which re-checks order_items under its lock. PostgreSQL needs an order-side serialization contract.
 */
export function deleteAuthorizedCanonicalPhoto(db: DbClient, driver: OwnershipDriver, canonicalRoot: string, photoId: string): CanonicalDeletionDisposition | Promise<CanonicalDeletionDisposition> {
  if (driver !== "sqlite") return Promise.resolve({ kind: "retained", code: "PHOTO_DELETE_REFERENCES_UNSERIALIZED" });
  return inOwnershipTransaction(db, driver, () => authorizedCanonicalDeletionSteps(driver, canonicalRoot, photoId));
}
