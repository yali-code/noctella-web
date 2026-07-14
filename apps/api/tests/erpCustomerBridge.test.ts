import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./testDb";
import * as schema from "../src/db/schema";
import { addConsent, addNote, createCustomer, executeMerge, getConsents, getStatistics, listNotes, mergeCandidates, setPreferences, tagCustomer, timeline, updateCustomer } from "../src/services/erpCustomerBridge";

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
