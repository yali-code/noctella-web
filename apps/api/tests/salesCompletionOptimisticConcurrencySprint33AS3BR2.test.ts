import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { createTransactionalSalesCompletionCoordinator, type SalesCompletionCommitInput } from "../src/application/sales/completionCoordination";
import { SaleConcurrencyConflictError, SalesCompletionIdempotencyConflictError } from "../src/application/sales/errors";
import { createPostgresSalesCompletionTransactionRepository } from "../src/repositories/sales-completion/postgres";
import { auditSalesCompletionConcurrencySource } from "../src/scripts/salesCompletionCoordinationAudit";
import { SqliteUnitOfWork } from "../src/services/unitOfWork";

const version = "2026-07-18T09:30:00.000Z";
const nextVersion = "2026-07-18T09:31:00.000Z";
const order = (id: string) => ({ id, orderNumber: `N-${id}`, guestEmail: "buyer@example.test", status: "Delivered", paymentStatus: "Paid", subtotalAmount: 100, shippingAmount: 10, taxAmount: 20, totalAmount: 130, currency: "EUR", billingAddress: "{}", shippingAddress: "{}", createdAt: version, updatedAt: version });
const shipment = (id: string) => ({ id: `sh:${id}`, orderId: id, carrierCode: "LocalPickup", status: "Delivered", shippingCost: 5, currency: "EUR", createdAt: version, updatedAt: version });
const input = (saleId: string, patch: Partial<SalesCompletionCommitInput> = {}): SalesCompletionCommitInput => {
  const snapshot = Object.freeze({ saleId, grossRevenue: 130, shippingCharged: 10, shippingCost: 5, marketplaceFee: null, promotedFee: null, paymentFee: null, taxVat: 20, itemCost: 40, netRevenue: 105, profit: 65, currency: "EUR" as const, completedAt: nextVersion });
  return Object.freeze({ expectedVersion: version, idempotencyKey: `complete:${saleId}`, payloadFingerprint: `sha256:${saleId}`, financialSnapshotId: `sf:${saleId}`, financeEntryId: `fe:${saleId}`, completionHistoryId: `he:${saleId}`, finalUpdatedAt: nextVersion, snapshot, financeEntry: Object.freeze({ saleId, entryType: "CompleteSale" as const, amount: 130, currency: "EUR" as const, sourceReference: saleId, idempotencyKey: `complete:${saleId}`, occurredAt: nextVersion, snapshot }), historyEntry: Object.freeze({ saleId, shipmentId: `sh:${saleId}`, eventType: "sale_completed" as const, occurredAt: nextVersion, financialSnapshot: snapshot }), ...patch });
};
function fixture(id: string) { const raw = new Database(":memory:"); ensureSchema(raw); const db = drizzle(raw, { schema }); db.insert(schema.orders).values(order(id)).run(); db.insert(schema.shipments).values(shipment(id)).run(); return { raw, coordinator: createTransactionalSalesCompletionCoordinator(new SqliteUnitOfWork(db as any)) }; }
const count = (raw: Database.Database, table: string) => Number((raw.prepare(`SELECT count(*) AS value FROM ${table}`).get() as any).value);
const sources = () => ({ contract: readFileSync(resolve(__dirname, "../src/application/sales/completionCoordination.ts"), "utf8"), sqlite: readFileSync(resolve(__dirname, "../src/repositories/sales-completion/sqlite.ts"), "utf8"), postgres: readFileSync(resolve(__dirname, "../src/repositories/sales-completion/postgres.ts"), "utf8") });

class PgDb {
  rows = new Map<string, any[]>(); updateRows = 1;
  async transaction<T>(work: (tx: this) => Promise<T>): Promise<T> { const before=new Map([...this.rows].map(([key,value])=>[key,value.map(row=>({...row}))])); try { return await work(this); } catch (error) { this.rows=before; throw error; } }
  insert(table: any) { const name = String(table); return { values: (value: any) => { const write = () => { this.rows.set(name, [...(this.rows.get(name) ?? []), value]); return [value]; }; return { then: (ok: any, bad: any) => Promise.resolve(write()).then(ok, bad), onConflictDoNothing: () => ({ returning: async () => write() }) }; } }; }
  select() { return { from: (table: any) => ({ where: async () => this.rows.get(String(table)) ?? [] }) }; }
  update(_table: any) { return { set: (_value: any) => ({ where: (_predicate: any) => ({ returning: async () => this.updateRows ? [{ id: "sale" }] : [] }) }) }; }
}

describe("Sprint 33A-S3BR2 completion optimistic concurrency (50 executable tests)", () => {
  const contractCases: Array<[string, (s: ReturnType<typeof sources>) => boolean]> = [
    ["commit input requires expectedVersion", s => /interface SalesCompletionCommitInput[\s\S]*readonly expectedVersion: SaleVersion/.test(s.contract)],
    ["commit input imports existing SaleVersion", s => /import type \{ SaleVersion \}/.test(s.contract)],
    ["commit input remains readonly", s => /readonly expectedVersion/.test(s.contract)],
    ["idempotency key remains present", s => /readonly idempotencyKey/.test(s.contract)],
    ["payload fingerprint remains present", s => /readonly payloadFingerprint/.test(s.contract)],
    ["snapshot remains present", s => /readonly snapshot/.test(s.contract)],
    ["finance entry remains present", s => /readonly financeEntry/.test(s.contract)],
    ["history entry remains present", s => /readonly historyEntry/.test(s.contract)],
  ];
  it.each(contractCases)("contract: %s", (_n, check) => expect(check(sources())).toBe(true));

  it("SQLite matching version succeeds", async () => { const f=fixture("match"); try { await expect(f.coordinator.commit(input("match"))).resolves.toMatchObject({replay:false}); } finally { f.raw.close(); } });
  it("SQLite stale version throws explicit concurrency error", async () => { const f=fixture("stale"); try { await expect(f.coordinator.commit(input("stale",{expectedVersion:"stale"}))).rejects.toBeInstanceOf(SaleConcurrencyConflictError); } finally { f.raw.close(); } });
  it("SQLite zero-row final update fails", async () => { const f=fixture("zero"); try { f.raw.prepare("DELETE FROM orders WHERE id=?").run("zero"); await expect(f.coordinator.commit(input("zero"))).rejects.toBeInstanceOf(SaleConcurrencyConflictError); } finally { f.raw.close(); } });
  it("SQLite advances version to finalUpdatedAt", async () => { const f=fixture("advance"); try { await f.coordinator.commit(input("advance")); expect((f.raw.prepare("SELECT updated_at v FROM orders WHERE id=?").get("advance") as any).v).toBe(nextVersion); } finally { f.raw.close(); } });
  it("SQLite stale rollback preserves sale status", async () => { const f=fixture("status"); try { await expect(f.coordinator.commit(input("status",{expectedVersion:"bad"}))).rejects.toThrow(); expect((f.raw.prepare("SELECT status FROM orders WHERE id=?").get("status") as any).status).toBe("Delivered"); } finally { f.raw.close(); } });
  for (const [name, table] of [["financial snapshot","sale_financials"],["finance entry","finance_entries"],["completion history","shipment_events"],["successful replay record","sale_completion_executions"]] as const) it(`SQLite stale rollback leaves no ${name}`, async () => { const f=fixture(`rollback-${table}`); try { await expect(f.coordinator.commit(input(`rollback-${table}`,{expectedVersion:"bad"}))).rejects.toThrow(); expect(count(f.raw,table)).toBe(table==="shipment_events"?0:0); } finally { f.raw.close(); } });
  it("SQLite exact replay succeeds without second mutation", async () => { const f=fixture("replay"); try { const first=await f.coordinator.commit(input("replay")); const replay=await f.coordinator.commit(input("replay",{expectedVersion:"stale"})); expect(replay).toMatchObject({replay:true,snapshot:first.snapshot}); expect(count(f.raw,"finance_entries")).toBe(1); } finally { f.raw.close(); } });
  it("SQLite conflicting replay remains conflict", async () => { const f=fixture("conflict"); try { await f.coordinator.commit(input("conflict")); await expect(f.coordinator.commit(input("conflict",{payloadFingerprint:"different"}))).rejects.toBeInstanceOf(SalesCompletionIdempotencyConflictError); } finally { f.raw.close(); } });
  it("SQLite stale non-replay attempt fails", async () => { const f=fixture("non-replay"); try { await expect(f.coordinator.commit(input("non-replay",{idempotencyKey:"new",expectedVersion:"bad"}))).rejects.toBeInstanceOf(SaleConcurrencyConflictError); } finally { f.raw.close(); } });
  it("SQLite replay result is deterministic", async () => { const f=fixture("deterministic"); try { const a=await f.coordinator.commit(input("deterministic")); const b=await f.coordinator.commit(input("deterministic")); expect({...b,replay:false}).toEqual(a); } finally { f.raw.close(); } });
  it("two SQLite attempts with one expected version allow first only", async () => { const f=fixture("race"); try { await expect(f.coordinator.commit(input("race"))).resolves.toBeTruthy(); await expect(f.coordinator.commit(input("race",{idempotencyKey:"second",payloadFingerprint:"second",financialSnapshotId:"sf:second",financeEntryId:"fe:second",completionHistoryId:"he:second"}))).rejects.toBeInstanceOf(SaleConcurrencyConflictError); } finally { f.raw.close(); } });
  it("failed concurrent attempt adds no duplicate effects", async () => { const f=fixture("effects"); try { await f.coordinator.commit(input("effects")); await expect(f.coordinator.commit(input("effects",{idempotencyKey:"other",payloadFingerprint:"other",financialSnapshotId:"sf:other",financeEntryId:"fe:other",completionHistoryId:"he:other"}))).rejects.toThrow(); expect([count(f.raw,"sale_financials"),count(f.raw,"finance_entries"),count(f.raw,"shipment_events"),count(f.raw,"sale_completion_executions")]).toEqual([1,1,1,1]); } finally { f.raw.close(); } });

  it("PostgreSQL matching version succeeds", async () => { const db=new PgDb(); await expect(createPostgresSalesCompletionTransactionRepository(db as any).commit(input("pg-ok"))).resolves.toMatchObject({replay:false}); });
  it("PostgreSQL zero-row update throws explicit concurrency error", async () => { const db=new PgDb(); db.updateRows=0; await expect(createPostgresSalesCompletionTransactionRepository(db as any).commit(input("pg-stale"))).rejects.toBeInstanceOf(SaleConcurrencyConflictError); });
  it("PostgreSQL stale version uses zero-row mapping", async () => { const db=new PgDb(); db.updateRows=0; await expect(createPostgresSalesCompletionTransactionRepository(db as any).commit(input("pg-version",{expectedVersion:"bad"}))).rejects.toMatchObject({code:"sale_concurrency_conflict"}); });
  it("PostgreSQL result preserves final version timestamp", async () => { const db=new PgDb(); const result=await createPostgresSalesCompletionTransactionRepository(db as any).commit(input("pg-next")); expect(result.completedAt).toBe(nextVersion); });
  it("PostgreSQL stale failure rolls back all completion effects", async () => { const db=new PgDb(); db.updateRows=0; await expect(db.transaction(tx=>createPostgresSalesCompletionTransactionRepository(tx as any).commit(input("pg-rollback")))).rejects.toBeInstanceOf(SaleConcurrencyConflictError); expect([...db.rows.values()].flat()).toHaveLength(0); });

  const auditCases: Array<[string, (s: ReturnType<typeof sources>) => boolean]> = [
    ["SQLite imports and",s=>s.sqlite.includes("and, eq")],["PostgreSQL imports and",s=>s.postgres.includes("and, eq")],
    ["SQLite guards sale id",s=>s.sqlite.includes("eq(schema.orders.id, input.snapshot.saleId)")],["PostgreSQL guards sale id",s=>s.postgres.includes("eq(schema.orders.id, input.snapshot.saleId)")],
    ["SQLite guards persisted version",s=>s.sqlite.includes("eq(schema.orders.updatedAt, input.expectedVersion)")],["PostgreSQL guards persisted version",s=>s.postgres.includes("eq(schema.orders.updatedAt, new Date(input.expectedVersion))")],
    ["SQLite rejects zero rows",s=>/finalized\.changes !== 1/.test(s.sqlite)],["PostgreSQL rejects zero rows",s=>/finalized\.length !== 1/.test(s.postgres)],
    ["SQLite maps concurrency error",s=>s.sqlite.includes("throw new SaleConcurrencyConflictError")],["PostgreSQL maps concurrency error",s=>s.postgres.includes("throw new SaleConcurrencyConflictError")],
    ["SQLite has no saleId-only final predicate",s=>!s.sqlite.includes("where(eq(schema.orders.id, input.snapshot.saleId)).run")],["PostgreSQL has no saleId-only final predicate",s=>!s.postgres.includes("where(eq(schema.orders.id, input.snapshot.saleId)).returning")],
    ["SQLite has no precheck-only version read",s=>!s.sqlite.includes("SELECT updated_at")],["PostgreSQL has no precheck-only version read",s=>!s.postgres.includes("SELECT updated_at")],
    ["SQLite adapter has no manual transaction",s=>!s.sqlite.includes(".transaction(")],["PostgreSQL adapter has no manual transaction",s=>!s.postgres.includes(".transaction(")],
    ["fixture rejects saleId-only SQLite update",s=>auditSalesCompletionConcurrencySource(s.contract,s.sqlite.replace("and(eq(schema.orders.id, input.snapshot.saleId), eq(schema.orders.updatedAt, input.expectedVersion))","eq(schema.orders.id, input.snapshot.saleId)"),s.postgres).status==="FAIL"],
    ["fixture rejects missing expectedVersion",s=>auditSalesCompletionConcurrencySource(s.contract.replace("readonly expectedVersion: SaleVersion;",""),s.sqlite,s.postgres).status==="FAIL"],
    ["fixture rejects silent zero-row handling",s=>auditSalesCompletionConcurrencySource(s.contract,s.sqlite.replace("if (finalized.changes !== 1) throw new SaleConcurrencyConflictError();",""),s.postgres).status==="FAIL"],
    ["fixture rejects precheck-only concurrency",s=>auditSalesCompletionConcurrencySource(s.contract,s.sqlite.replace("and(eq(schema.orders.id, input.snapshot.saleId), eq(schema.orders.updatedAt, input.expectedVersion))","eq(schema.orders.id, input.snapshot.saleId)"),s.postgres).issues.includes("SQLite sale update is not version guarded")],
    ["fixture accepts valid SQLite adapter",s=>auditSalesCompletionConcurrencySource(s.contract,s.sqlite,s.postgres).status==="PASS"],
    ["fixture accepts valid PostgreSQL adapter",s=>auditSalesCompletionConcurrencySource(s.contract,s.sqlite,s.postgres).status==="PASS"],
  ];
  it.each(auditCases)("audit: %s", (_n, check) => expect(check(sources())).toBe(true));
});
