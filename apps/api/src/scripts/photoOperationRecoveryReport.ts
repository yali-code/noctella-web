/**
 * FAZ A #424 package F: READ-ONLY operator report for generation-fenced photo operations (W2 product uploads, W4
 * finalizations and, only if its proposed table exists, W11 derivatives). Plain SELECTs, no transaction, no writes,
 * no file access. Usage: `npm run photos:operations-report -w apps/api` (prints JSON; exit 2 when attention needed).
 */
import { sql, type SQL } from "drizzle-orm";
import type { DbClient } from "../db/client";
import { nowMs, ownershipDriver, type OwnershipDriver } from "../services/photoOperationAuthority";
import { OWNERSHIP_ROLLBACK_BLOCKERS_SQL } from "../services/photoOwnershipFencing";

type Row = Record<string, any>;

export async function buildPhotoOperationReport(db: DbClient, driver: OwnershipDriver = ownershipDriver()) {
  const read = async (statement: SQL): Promise<Row[]> => (driver === "sqlite" ? (db as any).all(statement) : ((await (db as any).execute(statement)) as { rows: Row[] }).rows);
  const tableExists = async (name: string) => (driver === "sqlite"
    ? (await read(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${name}`)).length === 1
    : (await read(sql`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ${name}`)).length === 1);
  const now = nowMs(driver);
  const count = (rows: Row[]) => rows.map((r) => ({ ...r, n: Number(r.n) }));

  const ownership = await tableExists("photo_operations");
  const operations = ownership ? {
    byKindAndState: count(await read(sql`SELECT kind, state, COUNT(*) AS n FROM photo_operations GROUP BY kind, state ORDER BY kind, state`)),
    attention: await read(sql`SELECT id, kind, subject_type, subject_id, generation, state, main_key, thumb_key, review_reason, CASE WHEN lease_until_ms <= ${now} THEN 1 ELSE 0 END AS lease_expired
      FROM photo_operations WHERE state = 'review' OR (state IN ('preparing', 'sealed') AND lease_until_ms <= ${now}) ORDER BY created_ms`),
    rollbackBlockers: count(await read(sql.raw(OWNERSHIP_ROLLBACK_BLOCKERS_SQL))),
  } : null;
  const w2Intents = (await tableExists("photo_w2_upload_intents")) ? {
    total: Number((await read(sql`SELECT COUNT(*) AS n FROM photo_w2_upload_intents`))[0].n),
    unbound: Number((await read(sql`SELECT COUNT(*) AS n FROM photo_w2_upload_intents WHERE operation_id IS NULL`))[0].n),
  } : null;
  // W11 (proposed 0042) is reported only where its table exists; it is not created by any startup path today.
  const derivatives = (await tableExists("photo_derivative_operations")) ? {
    byState: count(await read(sql`SELECT state, COUNT(*) AS n FROM photo_derivative_operations GROUP BY state ORDER BY state`)),
    attention: await read(sql`SELECT id, derivative_key, generation, state, review_reason FROM photo_derivative_operations
      WHERE state = 'review' OR review_reason IS NOT NULL OR (state IN ('preparing', 'sealed') AND lease_until_ms <= ${now}) ORDER BY created_ms`),
  } : null;

  const attentionCount = (operations?.attention.length ?? 0) + (derivatives?.attention.length ?? 0) + (w2Intents?.unbound ?? 0);
  return { generatedAt: new Date().toISOString(), driver, readOnly: true, operations, w2Intents, derivatives, attentionCount, guidance: "Never delete files or edit rows from this report; follow docs/engineering/PHOTO_OPERATION_FENCING_RUNBOOK.md." };
}

if (require.main === module) {
  (async () => {
    const { dbRuntime } = await import("../db/client");
    const report = await buildPhotoOperationReport(dbRuntime.db as DbClient, ownershipDriver());
    console.log(JSON.stringify(report, null, 2));
    await dbRuntime.shutdown();
    process.exitCode = report.attentionCount > 0 ? 2 : 0;
  })().catch((error) => { console.error(String(error)); process.exitCode = 1; });
}
