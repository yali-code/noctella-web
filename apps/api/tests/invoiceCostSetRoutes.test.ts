import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import express from "express";

/**
 * PHASE-2C: route-level (real HTTP) tests for bank debit, product candidates/selection, preview and approve. Same
 * harness as invoiceIntakeRoutes.test.ts: the real routes/erp.ts router over an isolated in-memory SQLite db with a
 * real X-Noctella-ERP-Key. The ECB request is answered by a stubbed global fetch; no network call is made.
 */
let harnessDb: any;
vi.mock("../src/db/client", async () => {
  const Database = (await import("better-sqlite3")).default;
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const { ensureSchema } = await import("../src/db/migrate");
  const schema = await import("../src/db/schema");
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  ensureSchema(sqlite);
  harnessDb = drizzle(sqlite, { schema });
  return { db: harnessDb, dbRuntime: { driver: "sqlite", db: harnessDb, shutdown: async () => sqlite.close() } };
});

const ERP_KEY = "test-erp-key-2c";
const f = (value: unknown) => ({ value, evidence: value === null ? null : String(value), confidence: 0.95 });
const AUCTION = {
  invoiceType: f("auction"), supplierName: f("Växjö Auktionskammare"), supplierVatNumber: f(null), platform: f(null), invoiceNumber: f("227552"), issueDate: f("2026-09-15"),
  dueDate: f(null), paidDate: f("2026-09-18"), currency: f("SEK"), vatNote: f(null), reverseCharge: f(null), total: f(1198),
  lots: [{ lotNumber: f("5332164"), title: f("KAMEROR"), itemCountHint: f(2), amount: f(945) }],
  fees: [{ type: f("hammer_fee"), label: f("Hammer fee"), amount: f(64), percent: f(null), lotNumber: f(null) }, { type: f("buyer_premium"), label: f("Premium"), amount: f(189), percent: f(20), lotNumber: f(null) }],
};
const ECB_CSV = "TIME_PERIOD,OBS_VALUE\n2026-09-17,11.05\n2026-09-18,11.0625\n";

describe("invoice cost set allocation/approve ERP routes (PHASE-2C)", () => {
  let server: Server;
  let baseUrl: string;
  const headers = { "X-Noctella-ERP-Key": ERP_KEY, "X-Noctella-ERP-Client-Version": "0.1.0" };
  const jsonHeaders = { ...headers, "Content-Type": "application/json" };
  const realFetch = globalThis.fetch;
  const ecbUrls: string[] = [];
  let ecbDown = false;

  beforeAll(async () => {
    process.env.ERP_INTEGRATION_KEY = ERP_KEY;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
      const url = String(input);
      if (url.startsWith("https://data-api.ecb.europa.eu/")) {
        if (ecbDown) throw new TypeError("network down");
        ecbUrls.push(url);
        return new Response(ECB_CSV, { status: 200 });
      }
      return realFetch(input, init);
    });
    const erpRouter = (await import("../src/routes/erp")).default;
    const app = express();
    app.use(express.json());
    app.use("/api/erp", erpRouter);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  }, 60_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function seed() {
    const schema = await import("../src/db/schema.sqlite");
    const set = await (await fetch(`${baseUrl}/api/erp/invoice-cost-sets`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ title: "Route set" }) })).json();
    const intakeId = randomUUID();
    await harnessDb.insert(schema.invoiceIntakes).values({
      id: intakeId, costSetId: set.id, invoiceType: "auction", status: "reviewed", fileRelativePath: `${set.id}/${intakeId}.pdf`, fileSha256: "b".repeat(64), fileSizeBytes: 10, fileMime: "application/pdf",
      invoiceNumber: "227552", supplierName: "Växjö Auktionskammare", issueDate: "2026-09-15", paidDate: "2026-09-18", currency: "SEK", totalOriginal: 1198,
      extractionJson: JSON.stringify({ output: AUCTION, checks: [], model: "m", extractedAt: "2026-11-02T00:00:00.000Z" }),
    });
    const productIds: string[] = [];
    for (const [k, price] of [60, 40].entries()) {
      const id = `rp-${k}-${randomUUID().slice(0, 6)}`;
      const aiId = randomUUID();
      await harnessDb.insert(schema.products).values({ id, slug: id, sku: `RT-${k}-${id.slice(-6)}`, title: `Route camera ${k}`, type: "UniqueItem", status: "Draft" });
      await harnessDb.insert(schema.aiProductIntakes).values({ id: aiId, status: "finalized", createdByAdminUserId: "a", resultProductId: id });
      await harnessDb.insert(schema.aiIntakeProposals).values({ id: randomUUID(), intakeId: aiId, suggestedPriceEur: price, photoSetFingerprint: "fp", generatedAt: "2026-10-01T00:00:00.000Z", providerName: "mock", promptVersion: "v1" });
      productIds.push(id);
    }
    return { setId: set.id as string, intakeId, productIds };
  }

  it("requires the ERP key on every new endpoint", async () => {
    const calls: Array<[string, string]> = [
      ["POST", "/invoice-intakes/x/bank-debit"], ["GET", "/invoice-cost-sets/x/product-candidates"], ["PUT", "/invoice-cost-sets/x/products"],
      ["POST", "/invoice-cost-sets/x/preview"], ["POST", "/invoice-cost-sets/x/approve"],
    ];
    for (const [method, url] of calls) {
      const res = await fetch(`${baseUrl}/api/erp${url}`, { method, headers: { "X-Noctella-ERP-Client-Version": "0.1.0" } });
      expect(res.status, `${method} ${url}`).toBe(401);
    }
  });

  it("bank debit -> rate, picker, products, preview, approve -> Draft purchase; then 409 on a non-open set", async () => {
    const { setId, intakeId, productIds } = await seed();

    expect((await fetch(`${baseUrl}/api/erp/invoice-intakes/${intakeId}/bank-debit`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ bankDebitEur: -1 }) })).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/erp/invoice-intakes/${intakeId}/bank-debit`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ bankDebitEur: 1, x: 1 }) })).status).toBe(400);
    const debit = await fetch(`${baseUrl}/api/erp/invoice-intakes/${intakeId}/bank-debit`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ bankDebitEur: 109.65 }) });
    expect(debit.status).toBe(200);
    expect(await debit.json()).toMatchObject({ fxRate: 11.0625, fxRateDate: "2026-09-18", fxSource: "ECB", bankDebitEur: 109.65, fx: { officialEur: 108.29, fxDiffEur: 1.36 } });
    expect(ecbUrls.at(-1)).toBe("https://data-api.ecb.europa.eu/service/data/EXR/D.SEK.EUR.SP00.A?startPeriod=2026-09-08&endPeriod=2026-09-18&format=csvdata");

    const candidates = await (await fetch(`${baseUrl}/api/erp/invoice-cost-sets/${setId}/product-candidates?q=route camera`, { headers })).json();
    expect(candidates.items.map((c: any) => c.productId)).toEqual(expect.arrayContaining(productIds));

    expect((await fetch(`${baseUrl}/api/erp/invoice-cost-sets/${setId}/products`, { method: "PUT", headers: jsonHeaders, body: JSON.stringify({ items: [{ productId: productIds[0], valueWeightEur: 0 }] }) })).status).toBe(400);
    const put = await fetch(`${baseUrl}/api/erp/invoice-cost-sets/${setId}/products`, { method: "PUT", headers: jsonHeaders, body: JSON.stringify({ items: [{ productId: productIds[0] }, { productId: productIds[1], valueWeightEur: 20 }] }) });
    expect(put.status).toBe(200);
    expect((await put.json()).items.map((i: any) => [i.valueWeightEur, i.weightSource])).toEqual([[60, "ai"], [20, "admin"]]);

    const preview = await (await fetch(`${baseUrl}/api/erp/invoice-cost-sets/${setId}/preview`, { method: "POST", headers })).json();
    expect(preview.issues).toEqual([]);
    expect(preview.totalAllocatedEur).toBe(109.65);
    expect(Math.round(preview.items.reduce((a: number, i: any) => a + i.totalEur * 100, 0))).toBe(10965);

    const approve = await fetch(`${baseUrl}/api/erp/invoice-cost-sets/${setId}/approve`, { method: "POST", headers });
    expect(approve.status).toBe(200);
    const approved = await approve.json();
    expect(approved).toMatchObject({ status: "approved", approvedBy: "admin" });
    const purchase = await (await fetch(`${baseUrl}/api/erp/purchases/${approved.purchaseId}`, { headers })).json();
    expect(purchase).toMatchObject({ status: "Draft", erpReferenceId: `invoice-cost-set:${setId}` });
    expect(purchase.lines).toHaveLength(2);

    const detail = await (await fetch(`${baseUrl}/api/erp/invoice-cost-sets/${setId}`, { headers })).json();
    expect(detail).toMatchObject({ status: "approved", purchaseId: approved.purchaseId });
    expect(detail.items.map((i: any) => i.allocTotalEur)).toEqual(preview.items.map((i: any) => i.totalEur));

    expect((await fetch(`${baseUrl}/api/erp/invoice-cost-sets/${setId}/approve`, { method: "POST", headers })).status).toBe(409);
    expect((await fetch(`${baseUrl}/api/erp/invoice-cost-sets/${setId}/cancel`, { method: "POST", headers })).status).toBe(409);
  });

  it("approve with blocking issues is a 409 with the issue list; an ECB failure is a generic 502", async () => {
    const { setId, intakeId } = await seed();
    const blocked = await fetch(`${baseUrl}/api/erp/invoice-cost-sets/${setId}/approve`, { method: "POST", headers });
    expect(blocked.status).toBe(409);
    const body = await blocked.json();
    expect(body.code).toBe("INVOICE_COST_SET_BLOCKED");
    expect(body.issues.map((i: any) => i.code)).toEqual(expect.arrayContaining(["NO_PRODUCTS", "MISSING_RATE", "MISSING_BANK_DEBIT"]));

    ecbDown = true;
    const failed = await fetch(`${baseUrl}/api/erp/invoice-intakes/${intakeId}/bank-debit`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ bankDebitEur: 10 }) }).finally(() => { ecbDown = false; });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: "The official exchange rate is not available right now. Try again later.", code: "FX_RATE_UNAVAILABLE" });
  });
});
