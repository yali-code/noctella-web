/** Stage 5 W2 intent identity contract. Pure validation only; no DB or writer adoption. */
export interface W2UploadIntent {
  tenantId: string;
  actorId: string;
  productId: string;
  kind: "W2_PRODUCT_PHOTO_UPLOAD";
  token: string;
  sha256: string;
  altText: string;
}
export type W2IdentityDecision = "INVALID" | "NEW" | "SAME_INTENT" | "CONFLICT";
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SCOPE = /^[A-Za-z0-9:_-]{1,128}$/;
export function isValidW2UploadIntent(value: unknown): value is W2UploadIntent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return ["tenantId", "actorId", "productId"].every(k => typeof v[k] === "string" && SCOPE.test(v[k] as string))
    && v.kind === "W2_PRODUCT_PHOTO_UPLOAD"
    && typeof v.token === "string" && TOKEN.test(v.token)
    && typeof v.sha256 === "string" && SHA256.test(v.sha256)
    && typeof v.altText === "string" && v.altText.length <= 500;
}
const FIELDS = ["tenantId", "actorId", "productId", "kind", "token", "sha256", "altText"] as const;
export function classifyW2UploadIntent(stored: unknown, incoming: unknown): W2IdentityDecision {
  if (!isValidW2UploadIntent(incoming)) return "INVALID";
  if (stored === null) return "NEW";
  if (!isValidW2UploadIntent(stored)) return "CONFLICT";
  return FIELDS.every(field => stored[field] === incoming[field]) ? "SAME_INTENT" : "CONFLICT";
}

/**
 * SQLite-only durable admission prerequisite. The immediate transaction serializes
 * competing token claims; existing rows are compared without mutation. This does
 * NOT grant a photo-operation generation, touch files or adopt the live W2 writer.
 * PostgreSQL must use its own transactional implementation.
 */
export function claimSqliteW2UploadIntent(
  db: import("better-sqlite3").Database,
  incoming: unknown,
  createdMs: number,
): W2IdentityDecision {
  if (!isValidW2UploadIntent(incoming) || !Number.isSafeInteger(createdMs) || createdMs < 0) return "INVALID";
  return db.transaction((): W2IdentityDecision => {
    const insert = db.prepare(`INSERT INTO photo_w2_upload_intents
      (token, tenant_id, actor_id, product_id, input_sha256, alt_text, created_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`).run(
      incoming.token, incoming.tenantId, incoming.actorId, incoming.productId,
      incoming.sha256, incoming.altText, createdMs,
    );
    if (insert.changes === 1) return "NEW";
    const row = db.prepare(`SELECT token, tenant_id, actor_id, product_id, input_sha256, alt_text
      FROM photo_w2_upload_intents WHERE token = ?`).get(incoming.token) as
      | { token: string; tenant_id: string; actor_id: string; product_id: string; input_sha256: string; alt_text: string }
      | undefined;
    if (!row) return "CONFLICT"; // Do not mistake other constraint conflicts for a duplicate.
    return classifyW2UploadIntent({
      token: row.token, tenantId: row.tenant_id, actorId: row.actor_id,
      productId: row.product_id, sha256: row.input_sha256, altText: row.alt_text,
      kind: "W2_PRODUCT_PHOTO_UPLOAD",
    }, incoming);
  }).immediate();
}

/**
 * PostgreSQL counterpart to SQLite's durable W2 admission prerequisite.
 * A single acquired connection/transaction is essential: concurrently inserting the
 * same primary key waits for the winner, then reads its immutable intent.
 * No photo-operation generation, canonical write or outbox event is authorized here.
 */
export async function claimPostgresW2UploadIntent(
  pool: import("pg").Pool,
  incoming: unknown,
  createdMs: number,
): Promise<W2IdentityDecision> {
  if (!isValidW2UploadIntent(incoming) || !Number.isSafeInteger(createdMs) || createdMs < 0) return "INVALID";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO photo_w2_upload_intents
        (token, tenant_id, actor_id, product_id, input_sha256, alt_text, created_ms)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (token) DO NOTHING RETURNING token`,
      [incoming.token, incoming.tenantId, incoming.actorId, incoming.productId,
        incoming.sha256, incoming.altText, createdMs],
    );
    let decision: W2IdentityDecision;
    if (inserted.rowCount === 1) {
      decision = "NEW";
    } else {
      const existing = await client.query(
        `SELECT token, tenant_id, actor_id, product_id, input_sha256, alt_text
         FROM photo_w2_upload_intents WHERE token = $1 FOR UPDATE`,
        [incoming.token],
      );
      const row = existing.rows[0] as
        | { token: string; tenant_id: string; actor_id: string; product_id: string; input_sha256: string; alt_text: string }
        | undefined;
      decision = row ? classifyW2UploadIntent({
        kind: "W2_PRODUCT_PHOTO_UPLOAD", token: row.token,
        tenantId: row.tenant_id, actorId: row.actor_id, productId: row.product_id,
        sha256: row.input_sha256, altText: row.alt_text,
      }, incoming) : "CONFLICT";
    }
    await client.query("COMMIT");
    return decision;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* Preserve the original failure. */ }
    throw error;
  } finally {
    client.release();
  }
}
