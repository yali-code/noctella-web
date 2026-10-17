/** #462 TEST-ONLY protocol laboratory. Custom audit tables; never migration 0042 or production wiring. */
import Database from "better-sqlite3";
import pg from "pg";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { link } from "node:fs/promises";
import { rootedDescriptorProof, type RootedProof } from "./rootedDescriptorProof462";
import { assertDisposablePostgresUrl } from "../postgresTestDb";
export type AuditDriver = "sqlite" | "postgres";
export interface Session { q(text: string, args?: unknown[]): Promise<any[]>; begin(): Promise<void>; commit(): Promise<void>; rollback(): Promise<void>; close(): Promise<void> }
export interface Grant { generation: number; owner: string; nonce: string }
export interface Seal extends RootedProof, Grant { relative: string }
const ddl = [
  "CREATE TABLE audit_publication_guard (id TEXT PRIMARY KEY, generation BIGINT NOT NULL, owner TEXT NOT NULL, nonce TEXT NOT NULL, state TEXT NOT NULL, lease_ms BIGINT NOT NULL, canonical_generation BIGINT)",
  "CREATE TABLE audit_publication_intents (generation BIGINT PRIMARY KEY, owner TEXT NOT NULL, nonce TEXT NOT NULL UNIQUE)",
  "CREATE TABLE audit_publication_seals (generation BIGINT PRIMARY KEY, owner TEXT NOT NULL, nonce TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, bytes BIGINT NOT NULL, dev TEXT NOT NULL, ino TEXT NOT NULL, relative TEXT NOT NULL)",
];
export async function auditStore(driver: AuditDriver, dir: string) {
  let pool: pg.Pool | undefined, schema = "";
  const sqlitePath = path.join(dir, "audit.sqlite");
  if (driver === "postgres") {
    const url = assertDisposablePostgresUrl(process.env.POSTGRES_TEST_DATABASE_URL);
    schema = `audit462_${randomUUID().replace(/-/g, "")}`;
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    try { await admin.query(`CREATE SCHEMA "${schema}"`); } finally { await admin.end(); }
    pool = new pg.Pool({ connectionString: url, max: 4, options: `-c search_path=${schema}` });
  }
  const connect = async (): Promise<Session> => {
    if (driver === "postgres") {
      const client = await pool!.connect(); let active = false;
      const q = async (text: string, args: unknown[] = []) => { let n = 0; return (await client.query(text.replace(/\?/g, () => `$${++n}`), args)).rows; };
      return { q, begin: async () => { await q("BEGIN"); active = true; await q("SET LOCAL lock_timeout='500ms'"); }, commit: async () => { await q("COMMIT"); active = false; }, rollback: async () => { if (active) await q("ROLLBACK"); active = false; }, close: async () => { try { if (active) await q("ROLLBACK"); } finally { client.release(); } } };
    }
    const raw = new Database(sqlitePath); raw.pragma("busy_timeout=0");
    const q = async (text: string, args: unknown[] = []) => { const statement = raw.prepare(text); return statement.reader ? statement.all(...args) : (statement.run(...args), []); };
    return { q, begin: async () => { raw.exec("BEGIN IMMEDIATE"); }, commit: async () => { raw.exec("COMMIT"); }, rollback: async () => { if (raw.inTransaction) raw.exec("ROLLBACK"); }, close: async () => { if (raw.inTransaction) raw.exec("ROLLBACK"); raw.close(); } };
  };
  const init = await connect(); try { for (const text of ddl) await init.q(text); } finally { await init.close(); }
  const now = driver === "postgres" ? "(extract(epoch from clock_timestamp())*1000)::bigint" : "CAST(unixepoch('subsec')*1000 AS INTEGER)";
  const addSeal = (session: Session, seal: Seal) => session.q("INSERT INTO audit_publication_seals (generation,owner,nonce,sha256,bytes,dev,ino,relative) VALUES (?,?,?,?,?,?,?,?)", [seal.generation, seal.owner, seal.nonce, seal.sha256, seal.bytes, seal.dev, seal.ino, seal.relative]);
  const seed = async (seal: Seal) => { const s = await connect(); try { await s.begin(); await s.q(`INSERT INTO audit_publication_guard VALUES ('one',?,?,?,'sealed',${now}+60000,NULL)`, [seal.generation, seal.owner, seal.nonce]); await addSeal(s, seal); await s.commit(); } finally { await s.close(); } };
  const reclaim = async (seal: Seal) => {
    const s = await connect(); try { await s.begin(); const rows = await s.q(`UPDATE audit_publication_guard SET generation=?,owner=?,nonce=?,state='sealed',lease_ms=${now}+60000 WHERE id='one' AND generation=? AND state='sealed' AND lease_ms<=${now} RETURNING id`, [seal.generation, seal.owner, seal.nonce, seal.generation - 1]);
      if (rows.length !== 1) throw new Error("AUDIT_RECLAIM_REFUSED"); await addSeal(s, seal); await s.commit();
    } finally { await s.close(); }
  };
  const expire = async () => { const s = await connect(); try { await s.q("UPDATE audit_publication_guard SET lease_ms=0 WHERE id='one'"); } finally { await s.close(); } };
  const row = async () => { const s = await connect(); try { return (await s.q("SELECT * FROM audit_publication_guard WHERE id='one'"))[0]; } finally { await s.close(); } };
  const publish = async (root: string, grant: Grant, hooks: { locked?: (s: Session) => Promise<void>; granted?: () => Promise<void>; afterLink?: () => Promise<void>; beforeLink?: () => Promise<void> } = {}) => {
    // Phase 1 persists non-expiring authority. This connection is deliberately CLOSED before link().
    const s = await connect(); let seal: any;
    try {
      await s.begin(); const lock = driver === "postgres" ? " FOR UPDATE" : "";
      const op = (await s.q(`SELECT * FROM audit_publication_guard WHERE id='one'${lock}`))[0];
      if (!op || Number(op.generation) !== grant.generation || op.owner !== grant.owner || op.nonce !== grant.nonce || !["sealed", "publishing", "committed"].includes(op.state)) throw new Error("AUDIT_GRANT_REFUSED");
      seal = (await s.q("SELECT * FROM audit_publication_seals WHERE generation=? AND owner=? AND nonce=?", [grant.generation, grant.owner, grant.nonce]))[0];
      if (!seal) throw new Error("AUDIT_SEAL_MISSING");
      if (op.state === "sealed") {
        const admitted = await s.q(`UPDATE audit_publication_guard SET state='publishing' WHERE id='one' AND generation=? AND owner=? AND nonce=? AND state='sealed' AND lease_ms>${now} RETURNING id`, [grant.generation, grant.owner, grant.nonce]);
        if (admitted.length !== 1) throw new Error("AUDIT_GRANT_REFUSED");
        await s.q("INSERT INTO audit_publication_intents (generation,owner,nonce) VALUES (?,?,?)", [grant.generation, grant.owner, grant.nonce]);
        await hooks.locked?.(s);
      } else {
        const intent = await s.q("SELECT generation FROM audit_publication_intents WHERE generation=? AND owner=? AND nonce=?", [grant.generation, grant.owner, grant.nonce]);
        if (intent.length !== 1) throw new Error("AUDIT_GRANT_REFUSED");
        if (op.state === "committed") {
          const proof = await rootedDescriptorProof(root, "canonical.jpg");
          if (proof.sha256 !== seal.sha256 || proof.dev !== seal.dev || proof.ino !== seal.ino || proof.bytes !== Number(seal.bytes)) throw new Error("AUDIT_PROVENANCE_REVIEW");
          await s.commit(); return proof; // lost acknowledgement retry never reaches link
        }
      }
      await s.commit();
    } catch (error) { await s.rollback(); throw error; } finally { await s.close(); }
    await hooks.granted?.(); // no database connection/lock survives here; intent is durable authority
    const proof = await rootedDescriptorProof(root, seal.relative);
    if (proof.sha256 !== seal.sha256 || proof.ino !== seal.ino || proof.dev !== seal.dev || proof.bytes !== Number(seal.bytes)) throw new Error("AUDIT_SEAL_CHANGED");
    await hooks.beforeLink?.();
    try { await link(path.join(root, seal.relative), path.join(root, "canonical.jpg")); }
    catch (error: any) { if (error?.code !== "EEXIST") throw error; }
    const published = await rootedDescriptorProof(root, "canonical.jpg");
    if (published.sha256 !== seal.sha256 || published.dev !== seal.dev || published.ino !== seal.ino || published.bytes !== Number(seal.bytes)) throw new Error("AUDIT_PROVENANCE_REVIEW");
    await hooks.afterLink?.();
    // Phase 2 commits only the SAME durable intent; a publishing generation can never be reclaimed by expiry.
    const final = await connect();
    try {
      await final.begin();
      const committed = await final.q("UPDATE audit_publication_guard SET state='committed',canonical_generation=? WHERE id='one' AND generation=? AND owner=? AND nonce=? AND state IN ('publishing','committed') RETURNING id", [grant.generation, grant.generation, grant.owner, grant.nonce]);
      if (committed.length !== 1) throw new Error("AUDIT_COMMIT_REFUSED"); await final.commit(); return published;
    } catch (error) { await final.rollback(); throw error; } finally { await final.close(); }
  };
  const close = async () => {
    if (!pool) return;
    await pool.end(); const admin = new pg.Pool({ connectionString: assertDisposablePostgresUrl(process.env.POSTGRES_TEST_DATABASE_URL), max: 1 });
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); }
  };
  return { connect, seed, reclaim, expire, row, publish, close, nowSql: now };
}
