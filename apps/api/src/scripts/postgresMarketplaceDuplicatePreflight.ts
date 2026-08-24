import crypto from "node:crypto";
import pg from "pg";
import { redactSecrets } from "../db/config";

export const duplicateChecks = [
  { table: "marketplace_connections", columns: ["channel", "account_label"] },
  { table: "external_listings", columns: ["channel", "external_listing_id"] },
  { table: "marketplace_webhook_events", columns: ["channel", "external_event_id"] },
  { table: "marketplace_orders", columns: ["channel", "external_order_id"] },
] as const;

type Queryable = { query(sql: string): Promise<{ rows: Record<string, unknown>[] }> };
export type DuplicateFinding = { table: string; channel: string; keyFingerprint: string; duplicateCount: number };

export async function runMarketplaceDuplicatePreflight(client: Queryable): Promise<DuplicateFinding[]> {
  const findings: DuplicateFinding[] = [];
  await client.query("BEGIN TRANSACTION READ ONLY");
  try {
    for (const check of duplicateChecks) {
      const [channelColumn, keyColumn] = check.columns;
      const result = await client.query(`SELECT ${channelColumn} AS channel, ${keyColumn} AS duplicate_key, COUNT(*)::int AS duplicate_count FROM ${check.table} GROUP BY ${channelColumn}, ${keyColumn} HAVING COUNT(*) > 1 ORDER BY duplicate_count DESC, ${channelColumn}, ${keyColumn}`);
      for (const row of result.rows) findings.push({ table: check.table, channel: String(row.channel), keyFingerprint: crypto.createHash("sha256").update(String(row.duplicate_key)).digest("hex").slice(0, 12), duplicateCount: Number(row.duplicate_count) });
    }
    await client.query("ROLLBACK");
    return findings;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve the original failure */ }
    throw error;
  }
}

export async function main(env: NodeJS.ProcessEnv = process.env) {
  const connectionString = env.POSTGRES_PREFLIGHT_DATABASE_URL ?? (env.DATABASE_DRIVER === "supabase-postgres" ? env.SUPABASE_DATABASE_URL : env.DATABASE_URL);
  if (!connectionString || !/^postgres(?:ql)?:\/\//i.test(connectionString)) throw new Error("POSTGRES_PREFLIGHT_DATABASE_URL_REQUIRED");
  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: Number(env.DATABASE_POOL_TIMEOUT_MS ?? 5000) });
  const client = await pool.connect();
  try {
    const findings = await runMarketplaceDuplicatePreflight(client);
    if (findings.length) { for (const finding of findings) console.error(JSON.stringify(finding)); return 2; }
    console.log("Marketplace duplicate preflight PASS: zero duplicate groups");
    return 0;
  } finally { client.release(); await pool.end(); }
}

if (require.main === module) main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(redactSecrets(error instanceof Error ? error.message : String(error))); process.exitCode = 1; });
