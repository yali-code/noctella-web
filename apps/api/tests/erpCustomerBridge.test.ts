import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { createTestDb } from "./testDb";
import { ensureSchema } from "../src/db/migrate";
import { ConflictError } from "../src/services/errors";
import * as schema from "../src/db/schema";
import { addConsent, addNote, createCustomer, executeMerge, getConsents, getStatistics, listNotes, mergeCandidates, setPreferences, tagCustomer, timeline, updateCustomer } from "../src/services/erpCustomerBridge";

function memoryDb() { const sqlite = new Database(":memory:"); sqlite.pragma("foreign_keys = ON"); ensureSchema(sqlite); return { sqlite, db: drizzle(sqlite, { schema }) as any }; }
function mergeChecksum(sourceCustomerId: string, targetCustomerId: string) { return createHash("sha256").update(JSON.stringify({ sourceCustomerId, targetCustomerId })).digest("hex"); }

describe("erp customer bridge", () => {
  const db = () => createTestDb();
  it("supports customer CRUD, preferences, GDPR, notes, tags, audit and redaction", async () => {
    const d=db();
    const c:any=await createCustomer(d,"env",{payload:{name:"Ada",email:"ada@example.com",phone:"123456",vatNumber:"VAT1",erpReferenceId:"ERP-C1",addresses:[{type:"Shipping",line1:"Street",postalCode:"1000",city:"Brussels",country:"BE"}]}});
    expect(c.email).toBe("a***@example.com");
    await updateCustomer(d,"env",{payload:{customerId:c.id,name:"Ada Lovelace"}});
    expect((await setPreferences(d,"env",{payload:{customerId:c.id,language:"en",currency:"EUR"}}))?.currency).toBe("EUR");
    await addConsent(d,"env",{payload:{customerId:c.id,consentType:"Marketing",granted:false,privacyVersion:"v1",requestType:"DeleteRequest"}});
    expect((await getConsents(d,c.id)).deleteExecutes).toBe(false);
    await addNote(d,"env",{payload:{customerId:c.id,body:"sensitive note"}});
    expect((await listNotes(d,c.id)).items[0].body).toBe("[REDACTED]");
    await tagCustomer(d,"env",{payload:{customerId:c.id,tag:"vip"}});
    expect(await d.select().from(schema.erpIntegrationAudit)).not.toHaveLength(0);
  });
  it("detects merge candidates and executes idempotent explicit merges", async () => {
    const d=db(); const a:any=await createCustomer(d,"env",{payload:{name:"A",email:"same@test.dev"}}); const b:any=await createCustomer(d,"env",{payload:{name:"B"}});
    const candidates=await mergeCandidates(d,{payload:{email:"same@test.dev"}});
    expect(candidates.autoMerge).toBe(false); expect(candidates.candidates[0].reasons).toContain("Email");
    const first=await executeMerge(d,"env",{payload:{sourceCustomerId:a.id,targetCustomerId:b.id,idempotencyKey:"merge-1"}});
    const second=await executeMerge(d,"env",{payload:{sourceCustomerId:a.id,targetCustomerId:b.id,idempotencyKey:"merge-1"}});
    expect(first.status).toBe("Completed"); expect(second.idempotent).toBe(true);
    expect(await d.select().from(schema.customerMergeHistory).where(eq(schema.customerMergeHistory.idempotencyKey,"merge-1"))).toHaveLength(1);
  });
  it("builds timeline and analytics without fabricating incomplete values", async () => {
    const d=db(); const c:any=await createCustomer(d,"env",{payload:{name:"Timeline"}});
    await d.insert(schema.orders).values({ id:"o1", orderNumber:"N1", orderDraftId:null, customerId:c.id, guestEmail:"x@y.test", status:"completed", paymentStatus:"Paid", paymentProvider:null, paymentReference:null, subtotalAmount:100, shippingAmount:0, taxAmount:0, totalAmount:100, currency:"EUR", billingAddress:"{}", shippingAddress:"{}", notes:null, createdAt:"2026-01-01T00:00:00.000Z", updatedAt:"2026-01-01T00:00:00.000Z" });
    await addNote(d,"env",{payload:{customerId:c.id,body:"private"}});
    const t=await timeline(d,c.id); expect(t.readOnly).toBe(true); expect(t.items.map((i:any)=>i.type)).toEqual(expect.arrayContaining(["Order","Note"]));
    const stats=await getStatistics(d,c.id); expect(stats.lifetimeValue).toBe(100); expect(stats.favouriteBrand).toBeNull();
  });
});

describe("customer merge command idempotency (Sprint 47B)", () => {
  async function twoCustomers(d: any) {
    const a: any = await createCustomer(d, "env", { payload: { name: "A" } });
    const b: any = await createCustomer(d, "env", { payload: { name: "B" } });
    return { a, b };
  }

  it("A: a successful new merge reaches Completed with a real checksum and exactly one history/event/audit row", async () => {
    const { db: d } = memoryDb();
    const { a, b } = await twoCustomers(d);
    const result: any = await executeMerge(d, "env", { payload: { sourceCustomerId: a.id, targetCustomerId: b.id, idempotencyKey: "merge-a" } });
    expect(result.status).toBe("Completed");
    expect(result.idempotent).toBe(false);
    const [row]: any = await d.select().from(schema.erpCommandExecutions).where(eq(schema.erpCommandExecutions.idempotencyKey, "merge-a"));
    expect(row.status).toBe("Completed");
    expect(row.completedAt).toBeTruthy();
    expect(row.requestChecksum).not.toBe("customer-merge");
    expect(row.requestChecksum).toBe(mergeChecksum(a.id, b.id));
    expect(await d.select().from(schema.customerMergeHistory).where(eq(schema.customerMergeHistory.idempotencyKey, "merge-a"))).toHaveLength(1);
    expect(await d.select().from(schema.customerEvents).where(eq(schema.customerEvents.eventType, "CustomerMerged"))).toHaveLength(1);
    expect(await d.select().from(schema.erpIntegrationAudit).where(eq(schema.erpIntegrationAudit.action, "CustomerMerge"))).toHaveLength(1);
  });

  it("B: a Completed replay returns the stored result (not the current request), and performs no additional writes", async () => {
    const { sqlite, db: d } = memoryDb();
    const { a, b } = await twoCustomers(d);
    await executeMerge(d, "env", { payload: { sourceCustomerId: a.id, targetCustomerId: b.id, idempotencyKey: "merge-b" } });
    // Tamper the stored row directly to prove replay reads stored metadata, not the incoming request.
    sqlite.prepare("UPDATE erp_command_executions SET safe_result_metadata = ? WHERE idempotency_key = ?").run(JSON.stringify({ sourceCustomerId: "tampered-source", targetCustomerId: "tampered-target" }), "merge-b");
    const replay: any = await executeMerge(d, "env", { payload: { sourceCustomerId: a.id, targetCustomerId: b.id, idempotencyKey: "merge-b" } });
    expect(replay.idempotent).toBe(true);
    expect(replay.status).toBe("Completed");
    expect(replay.sourceCustomerId).toBe("tampered-source");
    expect(replay.targetCustomerId).toBe("tampered-target");
    expect(await d.select().from(schema.customerMergeHistory).where(eq(schema.customerMergeHistory.idempotencyKey, "merge-b"))).toHaveLength(1);
    expect(await d.select().from(schema.erpIntegrationAudit).where(eq(schema.erpIntegrationAudit.action, "CustomerMerge"))).toHaveLength(1);
  });

  it("C: reusing a key with a different source/target throws ConflictError and performs no writes", async () => {
    const { db: d } = memoryDb();
    const { a, b } = await twoCustomers(d);
    const c: any = await createCustomer(d, "env", { payload: { name: "C" } });
    await executeMerge(d, "env", { payload: { sourceCustomerId: a.id, targetCustomerId: b.id, idempotencyKey: "merge-c" } });
    await expect(executeMerge(d, "env", { payload: { sourceCustomerId: a.id, targetCustomerId: c.id, idempotencyKey: "merge-c" } })).rejects.toBeInstanceOf(ConflictError);
    expect(await d.select().from(schema.customerMergeHistory).where(eq(schema.customerMergeHistory.idempotencyKey, "merge-c"))).toHaveLength(1);
  });

  it("D: a recent Accepted row with a matching checksum throws ConflictError and performs no business writes", async () => {
    const { db: d } = memoryDb();
    const { a, b } = await twoCustomers(d);
    await d.insert(schema.erpCommandExecutions).values({ id: "row-d", clientId: "env", commandId: "merge-d", requestId: null, idempotencyKey: "merge-d", commandType: "MergeCustomer", entityType: "Customer", entityId: b.id, status: "Accepted", requestChecksum: mergeChecksum(a.id, b.id), createdAt: new Date().toISOString() });
    await expect(executeMerge(d, "env", { payload: { sourceCustomerId: a.id, targetCustomerId: b.id, idempotencyKey: "merge-d" } })).rejects.toThrow("ERP command is already in progress");
    expect(await d.select().from(schema.customerMergeHistory).where(eq(schema.customerMergeHistory.idempotencyKey, "merge-d"))).toHaveLength(0);
  });

  it("E: a stale Accepted row (older than 60s) with a matching checksum is reused, createdAt refreshed, no duplicate row", async () => {
    const { db: d } = memoryDb();
    const { a, b } = await twoCustomers(d);
    const staleCreatedAt = new Date(Date.now() - 61_000).toISOString();
    await d.insert(schema.erpCommandExecutions).values({ id: "row-e", clientId: "env", commandId: "merge-e", requestId: null, idempotencyKey: "merge-e", commandType: "MergeCustomer", entityType: "Customer", entityId: b.id, status: "Accepted", requestChecksum: mergeChecksum(a.id, b.id), createdAt: staleCreatedAt });
    const result: any = await executeMerge(d, "env", { payload: { sourceCustomerId: a.id, targetCustomerId: b.id, idempotencyKey: "merge-e" } });
    expect(result.status).toBe("Completed");
    const rows: any = await d.select().from(schema.erpCommandExecutions).where(eq(schema.erpCommandExecutions.idempotencyKey, "merge-e"));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("row-e");
    expect(new Date(rows[0].createdAt).getTime()).toBeGreaterThan(new Date(staleCreatedAt).getTime());
    expect(await d.select().from(schema.customerMergeHistory).where(eq(schema.customerMergeHistory.idempotencyKey, "merge-e"))).toHaveLength(1);
  });

  it("F: a Failed command can be retried with the same key and payload, reuses the same row, and can reach Completed", async () => {
    const { sqlite, db: d } = memoryDb();
    const { a, b } = await twoCustomers(d);
    sqlite.exec("ALTER TABLE erp_integration_audit RENAME TO erp_integration_audit_disabled");
    try {
      await expect(executeMerge(d, "env", { payload: { sourceCustomerId: a.id, targetCustomerId: b.id, idempotencyKey: "merge-f" } })).rejects.toThrow();
    } finally {
      sqlite.exec("ALTER TABLE erp_integration_audit_disabled RENAME TO erp_integration_audit");
    }
    const failedRows: any = await d.select().from(schema.erpCommandExecutions).where(eq(schema.erpCommandExecutions.idempotencyKey, "merge-f"));
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0].status).toBe("Failed");
    expect(failedRows[0].completedAt).toBeTruthy();
    expect(failedRows[0].safeErrorCode).toBeTruthy();
    expect(await d.select().from(schema.customerMergeHistory).where(eq(schema.customerMergeHistory.idempotencyKey, "merge-f"))).toHaveLength(0);

    const retried: any = await executeMerge(d, "env", { payload: { sourceCustomerId: a.id, targetCustomerId: b.id, idempotencyKey: "merge-f" } });
    expect(retried.status).toBe("Completed");
    const completedRows: any = await d.select().from(schema.erpCommandExecutions).where(eq(schema.erpCommandExecutions.idempotencyKey, "merge-f"));
    expect(completedRows).toHaveLength(1);
    expect(completedRows[0].id).toBe(failedRows[0].id);
    expect(completedRows[0].status).toBe("Completed");
  });

  it("G: a failure at the customerEvents write rolls back the already-inserted history row too — no false Completed", async () => {
    const { sqlite, db: d } = memoryDb();
    const { a, b } = await twoCustomers(d);
    sqlite.exec("ALTER TABLE customer_events RENAME TO customer_events_disabled");
    try {
      await expect(executeMerge(d, "env", { payload: { sourceCustomerId: a.id, targetCustomerId: b.id, idempotencyKey: "merge-g" } })).rejects.toThrow();
    } finally {
      sqlite.exec("ALTER TABLE customer_events_disabled RENAME TO customer_events");
    }
    expect(await d.select().from(schema.customerMergeHistory).where(eq(schema.customerMergeHistory.idempotencyKey, "merge-g"))).toHaveLength(0);
    expect(await d.select().from(schema.customerEvents).where(eq(schema.customerEvents.eventType, "CustomerMerged"))).toHaveLength(0);
    expect(await d.select().from(schema.erpIntegrationAudit).where(eq(schema.erpIntegrationAudit.action, "CustomerMerge"))).toHaveLength(0);
    const [row]: any = await d.select().from(schema.erpCommandExecutions).where(eq(schema.erpCommandExecutions.idempotencyKey, "merge-g"));
    expect(row.status).toBe("Failed");
    expect(row.completedAt).toBeTruthy();
  });

  it("H: a failure at the audit write rolls back both the history and event rows — no false Completed", async () => {
    const { sqlite, db: d } = memoryDb();
    const { a, b } = await twoCustomers(d);
    sqlite.exec("ALTER TABLE erp_integration_audit RENAME TO erp_integration_audit_disabled");
    try {
      await expect(executeMerge(d, "env", { payload: { sourceCustomerId: a.id, targetCustomerId: b.id, idempotencyKey: "merge-h" } })).rejects.toThrow();
    } finally {
      sqlite.exec("ALTER TABLE erp_integration_audit_disabled RENAME TO erp_integration_audit");
    }
    expect(await d.select().from(schema.customerMergeHistory).where(eq(schema.customerMergeHistory.idempotencyKey, "merge-h"))).toHaveLength(0);
    expect(await d.select().from(schema.customerEvents).where(eq(schema.customerEvents.eventType, "CustomerMerged"))).toHaveLength(0);
    const [row]: any = await d.select().from(schema.erpCommandExecutions).where(eq(schema.erpCommandExecutions.idempotencyKey, "merge-h"));
    expect(row.status).toBe("Failed");
  });

  it("I: a failure at the final Completed update rolls back all three business writes — no false Completed", async () => {
    const { sqlite, db: d } = memoryDb();
    const { a, b } = await twoCustomers(d);
    sqlite.exec("CREATE TRIGGER block_completed_i BEFORE UPDATE ON erp_command_executions WHEN NEW.status = 'Completed' BEGIN SELECT RAISE(ABORT, 'simulated failure before Completed update'); END;");
    try {
      await expect(executeMerge(d, "env", { payload: { sourceCustomerId: a.id, targetCustomerId: b.id, idempotencyKey: "merge-i" } })).rejects.toThrow();
    } finally {
      sqlite.exec("DROP TRIGGER block_completed_i");
    }
    expect(await d.select().from(schema.customerMergeHistory).where(eq(schema.customerMergeHistory.idempotencyKey, "merge-i"))).toHaveLength(0);
    expect(await d.select().from(schema.customerEvents).where(eq(schema.customerEvents.eventType, "CustomerMerged"))).toHaveLength(0);
    expect(await d.select().from(schema.erpIntegrationAudit).where(eq(schema.erpIntegrationAudit.action, "CustomerMerge"))).toHaveLength(0);
    const [row]: any = await d.select().from(schema.erpCommandExecutions).where(eq(schema.erpCommandExecutions.idempotencyKey, "merge-i"));
    expect(row.status).toBe("Failed");
    expect(row.completedAt).toBeTruthy();
  });
});
