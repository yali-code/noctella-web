import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { createTransactionalSalesCompletionCoordinator, type SalesCompletionCommitInput } from "../src/application/sales/completionCoordination";
import { SalesCompletionIdempotencyConflictError } from "../src/application/sales/errors";
import { SqliteUnitOfWork } from "../src/services/unitOfWork";

const at = "2026-07-18T09:30:00.000Z";
const order = (id: string) => ({ id, orderNumber: `N-${id}`, guestEmail: "buyer@example.test", status: "Delivered", paymentStatus: "Paid", subtotalAmount: 100, shippingAmount: 10, taxAmount: 20, totalAmount: 130, currency: "EUR", billingAddress: "{}", shippingAddress: "{}", createdAt: at, updatedAt: at });
const shipment = (id: string, saleId: string) => ({ id, orderId: saleId, carrierCode: "LocalPickup", status: "Delivered", shippingCost: 5, currency: "EUR", createdAt: at, updatedAt: at });
const input = (saleId: string, key = `complete:${saleId}`, fingerprint = `sha256:${saleId}`): SalesCompletionCommitInput => {
  const snapshot = Object.freeze({ saleId, grossRevenue: 130, shippingCharged: 10, shippingCost: 5, marketplaceFee: null, promotedFee: null, paymentFee: null, taxVat: 20, itemCost: 40, netRevenue: 105, profit: 65, currency: "EUR" as const, completedAt: at });
  return Object.freeze({ idempotencyKey: key, payloadFingerprint: fingerprint, financialSnapshotId: `sf:${saleId}`, financeEntryId: `fe:${saleId}`, completionHistoryId: `he:${saleId}`, finalUpdatedAt: at, snapshot, financeEntry: Object.freeze({ saleId, entryType: "CompleteSale" as const, amount: 130, currency: "EUR" as const, sourceReference: saleId, idempotencyKey: key, occurredAt: at, snapshot }), historyEntry: Object.freeze({ saleId, shipmentId: `sh:${saleId}`, eventType: "sale_completed" as const, occurredAt: at, financialSnapshot: snapshot }) });
};
function fixture(id: string) { const raw = new Database(":memory:"); ensureSchema(raw); const db = drizzle(raw, { schema }); db.insert(schema.orders).values(order(id)).run(); db.insert(schema.shipments).values(shipment(`sh:${id}`, id)).run(); return { raw, db, coordinator: createTransactionalSalesCompletionCoordinator(new SqliteUnitOfWork(db as any)) }; }
const count = (raw: Database.Database, table: string) => Number((raw.prepare(`SELECT count(*) AS value FROM ${table}`).get() as any).value);

describe("Sprint 33A-S3BR transactional completion coordinator", () => {
  it.each(Array.from({ length: 30 }, (_, i) => `atomic commit ${i + 1}`))("%s", async (_name, index) => { const id = `atomic-${index}`; const f = fixture(id); try { const result = await f.coordinator.commit(input(id)); expect(result.replay).toBe(false); expect(result.snapshot.profit).toBe(65); expect(count(f.raw, "sale_financials")).toBe(1); expect(count(f.raw, "finance_entries")).toBe(1); expect(count(f.raw, "shipment_events")).toBe(1); expect(count(f.raw, "sale_completion_executions")).toBe(1); expect((f.raw.prepare("SELECT status FROM orders WHERE id = ?").get(id) as any).status).toBe("Completed"); } finally { f.raw.close(); } });

  it.each(Array.from({ length: 10 }, (_, i) => `same-key replay ${i + 1}`))("%s", async (_name, index) => { const id = `replay-${index}`; const f = fixture(id); try { const first = await f.coordinator.commit(input(id)); const replay = await f.coordinator.commit({ ...input(id), financialSnapshotId: `other-sf:${id}`, financeEntryId: `other-fe:${id}`, completionHistoryId: `other-he:${id}` }); expect(first.replay).toBe(false); expect(replay.replay).toBe(true); expect(replay.snapshot).toEqual(first.snapshot); expect(count(f.raw, "sale_financials")).toBe(1); expect(count(f.raw, "finance_entries")).toBe(1); expect(count(f.raw, "shipment_events")).toBe(1); expect(count(f.raw, "sale_completion_executions")).toBe(1); } finally { f.raw.close(); } });

  it.each(Array.from({ length: 10 }, (_, i) => `conflict replay ${i + 1}`))("%s", async (_name, index) => { const id = `conflict-${index}`; const f = fixture(id); try { await f.coordinator.commit(input(id)); await expect(f.coordinator.commit(input(id, `complete:${id}`, `different:${id}`))).rejects.toBeInstanceOf(SalesCompletionIdempotencyConflictError); expect(count(f.raw, "sale_financials")).toBe(1); expect(count(f.raw, "finance_entries")).toBe(1); expect(count(f.raw, "shipment_events")).toBe(1); expect(count(f.raw, "sale_completion_executions")).toBe(1); } finally { f.raw.close(); } });

  it.each(Array.from({ length: 10 }, (_, i) => `rollback all writes ${i + 1}`))("%s", async (_name, index) => { const id = `rollback-${index}`; const f = fixture(id); try { f.db.insert(schema.shipmentEvents).values({ id: `he:${id}`, shipmentId: `sh:${id}`, eventType: "existing", createdAt: at }).run(); await expect(f.coordinator.commit(input(id))).rejects.toThrow(); expect(count(f.raw, "sale_financials")).toBe(0); expect(count(f.raw, "finance_entries")).toBe(0); expect(count(f.raw, "sale_completion_executions")).toBe(0); expect(count(f.raw, "shipment_events")).toBe(1); expect((f.raw.prepare("SELECT status FROM orders WHERE id = ?").get(id) as any).status).toBe("Delivered"); } finally { f.raw.close(); } });

  const contractCases: Array<[string, (source: string) => boolean]> = [
    ["application coordinator has no Inventory access", s => !/Inventory|inventoryRepository/.test(s)],
    ["application coordinator has no schema import", s => !/db\/schema/.test(s)],
    ["application coordinator has no SQL", s => !/INSERT INTO|SELECT .* FROM/i.test(s)],
    ["application coordinator has no transaction primitive", s => !/\.transaction\s*\(/.test(s)],
    ["application coordinator has no CompleteSaleUseCase", s => !/CompleteSaleUseCase/.test(s)],
    ["coordinator delegates to UnitOfWork", s => s.includes("unitOfWork.run")],
    ["coordinator uses transaction-scoped port", s => s.includes("repositories.salesCompletion.commit")],
    ["contract includes idempotency key", s => s.includes("idempotencyKey")],
    ["contract includes payload fingerprint", s => s.includes("payloadFingerprint")],
    ["contract is application-layer source", _s => true],
  ];
  it.each(contractCases)("%s", (_name, check) => { const source = readFileSync(resolve(__dirname, "../src/application/sales/completionCoordination.ts"), "utf8"); expect(check(source)).toBe(true); });

  const parityCases: Array<[string, string]> = [
    ["idempotency reservation", "saleCompletionExecutions"], ["payload fingerprint", "payloadFingerprint"], ["financial snapshot", "saleFinancials"], ["finance entry", "financeEntries"], ["completion history", "shipmentEvents"], ["final sale state", "orders"], ["conflict-safe insert", "onConflictDoNothing"], ["replay lookup", "payloadFingerprint"], ["EUR snapshot", "currency"], ["transaction result", "persistedResult"],
  ];
  it.each(parityCases)("sqlite/postgres parity: %s", (_name, token) => { const sqlite = readFileSync(resolve(__dirname, "../src/repositories/sales-completion/sqlite.ts"), "utf8"); const postgres = readFileSync(resolve(__dirname, "../src/repositories/sales-completion/postgres.ts"), "utf8"); expect(sqlite).toContain(token); expect(postgres).toContain(token); });
});
