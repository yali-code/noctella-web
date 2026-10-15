/**
 * P2-2B3D3 (#396): development-only, read-only photo recovery classification.
 *
 * NOT wired into any route, scheduler, startup hook or service default. Guarded like
 * #406/#408: NODE_ENV=test|development, PRODUCT_PHOTO_DISK_STAGING_ENABLED=true and every
 * root under os.tmpdir()/noctella-photo-fence-*.
 *
 * It never deletes, renames, quarantines, truncates or rewrites an artifact and never
 * removes a marker or reservation. Its only writes are an exclusive (wx + fsync) review
 * record in its own review directory and, optionally, closing the disk budget (fail closed).
 *
 * Protocol: inventory A -> authoritative DB/outbox reference snapshot (one consistent
 * read-only transaction) -> inventory B. A file is classified on B; it can only become an
 * UNREFERENCED_CANDIDATE when it is identical in A and B (dev, ino, size, mtime), the snapshot
 * is authoritative, it lives in a generation-private tree whose operation is known and has
 * moved to a NEWER generation (reclaim fencing from #406 revokes the old token), it is not
 * sealed/recorded, and no operation marker exists. Age, PID, TTL or lease expiry are never used.
 * Even candidates are only reported: cleanup is not authorized.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type ArtifactClass =
  | "REFERENCED"
  | "REFERENCED_VIA_CANONICAL_LINK"
  | "SEALED_RECORD_RETAINED"
  | "CURRENT_GENERATION_RETAINED"
  | "OPERATION_MARKER_RETAINED"
  | "UNREFERENCED_CANDIDATE"
  | "AMBIGUOUS_DB_UNAVAILABLE"
  | "AMBIGUOUS_UNFENCED_ROOT"
  | "AMBIGUOUS_ZERO_BYTE"
  | "AMBIGUOUS_CHANGING"
  | "AMBIGUOUS_UNKNOWN_OPERATION"
  | "AMBIGUOUS_FUTURE_GENERATION"
  | "AMBIGUOUS_UNEXPECTED_LAYOUT";

/** Classes that require operator review before admission may reopen. */
const REVIEW_CLASSES = new Set<ArtifactClass>(["OPERATION_MARKER_RETAINED", "AMBIGUOUS_DB_UNAVAILABLE", "AMBIGUOUS_UNFENCED_ROOT", "AMBIGUOUS_ZERO_BYTE", "AMBIGUOUS_CHANGING", "AMBIGUOUS_UNKNOWN_OPERATION", "AMBIGUOUS_FUTURE_GENERATION", "AMBIGUOUS_UNEXPECTED_LAYOUT"]);

export interface PhotoReferenceSnapshot {
  engine: "sqlite" | "postgres";
  /** File names referenced in the canonical product-photo root (rows, historical URLs, outbox payloads of any status). */
  canonical: Map<string, string[]>;
  /** File names referenced in the AI-intake private root. */
  intake: Map<string, string[]>;
  /** File names referenced in the media-asset root (rendered reels). */
  media: Map<string, string[]>;
  /** #406 capability authority: operation -> current generation; recorded seal directories (relative to the private root). */
  operations: Map<string, number>;
  seals: Set<string>;
  /** Optional reference sources absent from this engine/schema (recorded, never silently assumed empty). */
  missingOptional: string[];
  /** Ownership operations in 'review' state (proposed schema): always require operator review. */
  reviewOperations?: string[];
}

export interface PhotoRecoveryRoots {
  canonical: string;
  intake?: string;
  media?: string;
  /** #406 generation-private tree (<op>/g<N>/<attempt>/{raw,work,sealed}/file, locks/<op>.lock). */
  private?: string;
  /** Staging trees (HTTP ingress, AI ingress): never referenced by the DB, always writer-owned. */
  staging?: string[];
}

export interface ClassifiedArtifact { root: keyof PhotoRecoveryRoots | "staging"; path: string; dev: string; ino: string; size: number; class: ArtifactClass; reasons: string[] }
export interface PhotoRecoveryReport {
  id: string;
  generatedAt: string;
  engine: string | null;
  snapshotError: string | null;
  missingOptional: string[];
  reviewRequired: boolean;
  cleanup: "BLOCKED_NOT_AUTHORIZED";
  artifacts: ClassifiedArtifact[];
  missingReferenced: { name: string; sources: string[] }[];
  reviewOperations: string[];
  retainedBytesByClass: Partial<Record<ArtifactClass, number>>;
}

const fail = (code: string): never => { throw new Error(code); };
const DISPOSABLE = () => path.join(os.tmpdir(), "noctella-photo-fence-");
const PUBLIC_PREFIX = "/images/product-photos/";
const nameOf = (value: unknown): string | null => {
  if (typeof value !== "string" || !value) return null;
  const base = value.startsWith(PUBLIC_PREFIX) ? value.slice(PUBLIC_PREFIX.length) : value.includes("/") || value.includes("\\") ? null : value;
  return base && /^[a-zA-Z0-9._-]{1,200}$/.test(base) && !base.includes("..") ? base : null;
};
const add = (map: Map<string, string[]>, value: unknown, source: string) => {
  const name = nameOf(value);
  if (name) map.set(name, [...(map.get(name) ?? []), source]);
};

export function assertDevelopmentRecovery(paths: string[]): void {
  if (!["test", "development"].includes(process.env.NODE_ENV ?? "") || process.env.PRODUCT_PHOTO_DISK_STAGING_ENABLED !== "true") fail("PHOTO_DEVELOPMENT_RECOVERY_DISABLED");
  for (const p of paths) if (!path.resolve(p).startsWith(DISPOSABLE())) fail("PHOTO_DISPOSABLE_RECOVERY_REQUIRED");
}

interface Rows { q(sql: string): Promise<Record<string, unknown>[]> | Record<string, unknown>[] }
const REQUIRED = ["product_photos", "outbox_events", "ai_intake_photos"];
const OPTIONAL = ["categories", "collections", "order_items", "media_plan_items", "probe_photo_operations", "probe_photo_seals", "photo_operations", "photo_operation_artifacts"];

async function buildSnapshot(engine: "sqlite" | "postgres", tables: Set<string>, rows: Rows): Promise<PhotoReferenceSnapshot> {
  for (const table of REQUIRED) if (!tables.has(table)) fail(`PHOTO_REFERENCE_SOURCE_MISSING:${table}`);
  const snapshot: PhotoReferenceSnapshot = { engine, canonical: new Map(), intake: new Map(), media: new Map(), operations: new Map(), seals: new Set(), missingOptional: OPTIONAL.filter((t) => !tables.has(t)) };
  for (const r of await rows.q("SELECT id, url, thumbnail_url, filename, storage_key, thumbnail_storage_key FROM product_photos")) {
    for (const column of ["url", "thumbnail_url", "filename", "storage_key", "thumbnail_storage_key"]) add(snapshot.canonical, r[column], `product_photos.${column}:${r.id}`);
  }
  // Every status (pending, processing, completed, dead-lettered): historical payloads keep references alive.
  for (const r of await rows.q("SELECT id, event_type, status, payload FROM outbox_events WHERE event_type LIKE 'product_photo.%'")) {
    let payload: Record<string, unknown>;
    try { payload = typeof r.payload === "string" ? JSON.parse(r.payload) : (r.payload as Record<string, unknown>); } catch { fail(`PHOTO_OUTBOX_PAYLOAD_UNREADABLE:${r.id}`); }
    for (const key of ["url", "thumbnailUrl", "storageKey", "thumbnailStorageKey", "filename"]) add(snapshot.canonical, payload![key], `outbox_events.${r.event_type}.${r.status}:${r.id}`);
  }
  for (const r of await rows.q("SELECT id, storage_key FROM ai_intake_photos")) add(snapshot.intake, r.storage_key, `ai_intake_photos:${r.id}`);
  if (tables.has("categories")) for (const r of await rows.q("SELECT id, display_image_url FROM categories")) add(snapshot.canonical, r.display_image_url, `categories.display_image_url:${r.id}`);
  if (tables.has("collections")) for (const r of await rows.q("SELECT id, cover_image_url FROM collections")) add(snapshot.canonical, r.cover_image_url, `collections.cover_image_url:${r.id}`);
  if (tables.has("order_items")) for (const r of await rows.q("SELECT id, product_image_url FROM order_items")) add(snapshot.canonical, r.product_image_url, `order_items.product_image_url:${r.id}`);
  if (tables.has("media_plan_items")) for (const r of await rows.q("SELECT id, reel_asset_path FROM media_plan_items")) add(snapshot.media, typeof r.reel_asset_path === "string" ? path.basename(r.reel_asset_path) : null, `media_plan_items.reel_asset_path:${r.id}`);
  if (tables.has("probe_photo_operations")) for (const r of await rows.q("SELECT id, generation FROM probe_photo_operations")) snapshot.operations.set(String(r.id), Number(r.generation));
  // Proposed P2-2B3D5 ownership schema (when present): every operation state keeps its canonical keys referenced.
  if (tables.has("photo_operations")) for (const r of await rows.q("SELECT id, state, generation, main_key, thumb_key FROM photo_operations")) {
    const generation = Number(r.generation);
    if (!Number.isSafeInteger(generation) || generation < 1) fail(`PHOTO_OPERATION_GENERATION_INVALID:${r.id}`);
    snapshot.operations.set(String(r.id), generation);
    if (r.state === "review") (snapshot.reviewOperations ??= []).push(String(r.id));
    add(snapshot.canonical, r.main_key, `photo_operations.${r.state}:${r.id}`);
    add(snapshot.canonical, r.thumb_key, `photo_operations.${r.state}:${r.id}`);
  }
  if (tables.has("photo_operation_artifacts")) for (const r of await rows.q("SELECT relative_path FROM photo_operation_artifacts")) snapshot.seals.add(String(r.relative_path).split(/[\\/]/).join("/"));
  if (tables.has("probe_photo_seals")) for (const r of await rows.q("SELECT payload FROM probe_photo_seals")) {
    const relative = JSON.parse(String(r.payload)).relative;
    if (typeof relative === "string") snapshot.seals.add(relative.split(path.sep).join("/"));
  }
  return snapshot;
}

/** One consistent read transaction on SQLite (better-sqlite3 is synchronous; no Promise escapes the callback). */
export function collectSqlitePhotoReferences(sqlite: { prepare(sql: string): { all(...args: unknown[]): unknown[] }; transaction<T>(fn: () => T): () => T }): Promise<PhotoReferenceSnapshot> {
  const read = sqlite.transaction(() => {
    const tables = new Set((sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name));
    const results = new Map<string, Record<string, unknown>[]>();
    const rows: Rows = { q: (sql) => { const r = sqlite.prepare(sql).all() as Record<string, unknown>[]; results.set(sql, r); return r; } };
    // Collect synchronously inside the transaction; buildSnapshot's awaits only touch already-read arrays.
    for (const table of REQUIRED.concat(OPTIONAL)) if (tables.has(table)) rows.q(`SELECT * FROM ${table}`);
    return { tables, results };
  });
  const { tables, results } = read();
  const replay: Rows = { q: (sql) => {
    const table = /FROM (\w+)/.exec(sql)![1];
    const all = results.get(`SELECT * FROM ${table}`) ?? [];
    return /event_type LIKE 'product_photo\.%'/.test(sql) ? all.filter((r) => String(r.event_type).startsWith("product_photo.")) : all;
  } };
  return buildSnapshot("sqlite", tables, replay);
}

/** One REPEATABLE READ READ ONLY transaction on PostgreSQL. */
export async function collectPostgresPhotoReferences(pool: { connect(): Promise<{ query(sql: string): Promise<{ rows: Record<string, unknown>[] }>; release(): void }> }): Promise<PhotoReferenceSnapshot> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      const tables = new Set((await client.query("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()")).rows.map((r) => String(r.name)));
      const snapshot = await buildSnapshot("postgres", tables, { q: async (sql) => (await client.query(sql)).rows });
      await client.query("COMMIT");
      return snapshot;
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  } finally { client.release(); }
}

interface Entry { root: ClassifiedArtifact["root"]; rel: string; dev: string; ino: string; size: number; mtime: string }
function scan(roots: PhotoRecoveryRoots): Map<string, Entry> {
  const out = new Map<string, Entry>();
  const walk = (root: ClassifiedArtifact["root"], base: string, dir: string, depth: number) => {
    let names: string[];
    try { names = fs.readdirSync(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const name of names) {
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file, { bigint: true });
      const rel = path.relative(base, file).split(path.sep).join("/");
      if (stat.isDirectory() && !stat.isSymbolicLink() && depth < 8) { walk(root, base, file, depth + 1); continue; }
      out.set(`${root}:${rel}`, { root, rel, dev: stat.dev.toString(), ino: stat.ino.toString(), size: stat.isFile() && !stat.isSymbolicLink() ? Number(stat.size) : -1, mtime: stat.mtimeNs.toString() });
    }
  };
  walk("canonical", roots.canonical, roots.canonical, 0);
  if (roots.intake) walk("intake", roots.intake, roots.intake, 0);
  if (roots.media) walk("media", roots.media, roots.media, 0);
  if (roots.private) walk("private", roots.private, roots.private, 0);
  for (const staging of roots.staging ?? []) walk("staging", staging, staging, 0);
  return out;
}

function classify(entry: Entry, before: Entry | undefined, snapshot: PhotoReferenceSnapshot | null, canonicalInodes: Set<string>, markers: Set<string>): Pick<ClassifiedArtifact, "class" | "reasons"> {
  if (entry.size < 0) return { class: "AMBIGUOUS_UNEXPECTED_LAYOUT", reasons: ["not a regular file (symlink/special/too deep)"] };
  if (!snapshot) return { class: "AMBIGUOUS_DB_UNAVAILABLE", reasons: ["no authoritative reference snapshot"] };
  const stable = before && before.dev === entry.dev && before.ino === entry.ino && before.size === entry.size && before.mtime === entry.mtime;
  const refs = entry.root === "canonical" ? snapshot.canonical.get(entry.rel) : entry.root === "intake" ? snapshot.intake.get(entry.rel) : entry.root === "media" ? snapshot.media.get(entry.rel) : undefined;
  if (refs?.length) return { class: "REFERENCED", reasons: refs };
  if (entry.root !== "private") {
    if (entry.size === 0) return { class: "AMBIGUOUS_ZERO_BYTE", reasons: ["zero-byte file outside a fenced generation (reserved placeholder or partial write)"] };
    // Unprotected (legacy/Instagram/AI/staging) writers create files before COMMIT: absence of a row is not proof.
    return { class: "AMBIGUOUS_UNFENCED_ROOT", reasons: [stable ? "no authoritative reference; root has unfenced writers" : "changed during recovery; root has unfenced writers"] };
  }
  const parts = entry.rel.split("/");
  if (parts[0] === "locks") return { class: "OPERATION_MARKER_RETAINED", reasons: ["live or crash-retained operation marker (never removed automatically)"] };
  const [op, gen, , area] = parts;
  const generation = /^g([1-9][0-9]{0,15})$/.exec(gen ?? "")?.[1];
  if (parts.length !== 5 || !generation || !["raw", "work", "sealed"].includes(area)) return { class: "AMBIGUOUS_UNEXPECTED_LAYOUT", reasons: ["not <op>/g<N>/<attempt>/{raw,work,sealed}/<file>"] };
  if (markers.has(op)) return { class: "OPERATION_MARKER_RETAINED", reasons: [`operation ${op} has a retained marker`] };
  const current = snapshot.operations.get(op);
  if (current === undefined) return { class: "AMBIGUOUS_UNKNOWN_OPERATION", reasons: [`operation ${op} not in the authority snapshot`] };
  const n = Number(generation);
  if (n > current) return { class: "AMBIGUOUS_FUTURE_GENERATION", reasons: [`generation ${n} > authoritative ${current} (rollback/ABA)`] };
  if (area === "sealed" && canonicalInodes.has(`${entry.dev}:${entry.ino}`)) return { class: "REFERENCED_VIA_CANONICAL_LINK", reasons: ["sealed inode is a canonical hardlink"] };
  if (snapshot.seals.has(parts.slice(0, 3).concat("sealed").join("/")) && area === "sealed") return { class: "SEALED_RECORD_RETAINED", reasons: ["seal record references this sealed copy"] };
  if (n === current) return { class: "CURRENT_GENERATION_RETAINED", reasons: ["current generation: an owner may still be producing or publishing"] };
  if (!stable) return { class: "AMBIGUOUS_CHANGING", reasons: ["stale generation changed between inventories (late native writer)"] };
  return { class: "UNREFERENCED_CANDIDATE", reasons: [`generation ${n} superseded by ${current}; unsealed; no marker; stable${entry.size === 0 ? "; zero-byte partial output" : ""}`] };
}

export interface RecoveryOptions {
  roots: PhotoRecoveryRoots;
  /** Durable review records directory (exclusive per run). */
  reviewDir: string;
  references: () => Promise<PhotoReferenceSnapshot>;
  /** Optional fail-closed hook, e.g. DevelopmentPhotoDiskBudget.close. */
  closeAdmission?: (reason: string) => void;
}

export async function runDevelopmentPhotoRecovery(options: RecoveryOptions): Promise<{ report: PhotoRecoveryReport; recordPath: string }> {
  const { roots } = options;
  assertDevelopmentRecovery([roots.canonical, roots.intake, roots.media, roots.private, ...(roots.staging ?? []), options.reviewDir].filter((p): p is string => Boolean(p)));
  const before = scan(roots);
  let snapshot: PhotoReferenceSnapshot | null = null, snapshotError: string | null = null;
  try { snapshot = await options.references(); } catch (error) { snapshotError = (error as Error).message.slice(0, 200) || "PHOTO_REFERENCE_SNAPSHOT_FAILED"; }
  const after = scan(roots);
  const canonicalInodes = new Set([...after.values()].filter((e) => e.root === "canonical").map((e) => `${e.dev}:${e.ino}`));
  const markers = new Set([...after.values()].filter((e) => e.root === "private" && e.rel.startsWith("locks/") && e.rel.endsWith(".lock")).map((e) => e.rel.slice(6, -5)));
  const artifacts: ClassifiedArtifact[] = [...after.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => ({ root: entry.root, path: entry.rel, dev: entry.dev, ino: entry.ino, size: entry.size, ...classify(entry, before.get(key), snapshot, canonicalInodes, markers) }));
  const present = new Set(artifacts.filter((a) => a.root === "canonical").map((a) => a.path));
  const missingReferenced = snapshot ? [...snapshot.canonical.entries()].filter(([name]) => !present.has(name)).map(([name, sources]) => ({ name, sources })) : [];
  const retainedBytesByClass: Partial<Record<ArtifactClass, number>> = {};
  const counted = new Set<string>();
  for (const a of artifacts) {
    if (a.size < 0 || counted.has(`${a.dev}:${a.ino}`)) continue;
    counted.add(`${a.dev}:${a.ino}`);
    retainedBytesByClass[a.class] = (retainedBytesByClass[a.class] ?? 0) + a.size;
  }
  const reviewRequired = Boolean(snapshotError) || missingReferenced.length > 0 || (snapshot?.reviewOperations?.length ?? 0) > 0 || artifacts.some((a) => REVIEW_CLASSES.has(a.class));
  const report: PhotoRecoveryReport = { id: randomUUID(), generatedAt: new Date().toISOString(), engine: snapshot?.engine ?? null, snapshotError, missingOptional: snapshot?.missingOptional ?? [], reviewRequired, cleanup: "BLOCKED_NOT_AUTHORIZED", artifacts, missingReferenced, reviewOperations: snapshot?.reviewOperations ?? [], retainedBytesByClass };
  fs.mkdirSync(options.reviewDir, { recursive: true, mode: 0o700 });
  const recordPath = path.join(options.reviewDir, `recovery-${report.id}.json`);
  const fd = fs.openSync(recordPath, "wx", 0o600);
  try { fs.writeSync(fd, JSON.stringify(report, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (reviewRequired) options.closeAdmission?.(`photo recovery review required: ${recordPath}`);
  return { report, recordPath };
}
