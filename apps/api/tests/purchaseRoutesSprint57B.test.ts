import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import express from "express";
import { ProductStatus, ProductType, SupplierType } from "@noctella/shared";

/**
 * Sprint 57B: route-level (real HTTP) tests for the purchasing command endpoints,
 * none of which existed before this sprint. Mounts the real apps/api/src/routes/erp.ts
 * router in an isolated Express app over an isolated in-memory SQLite db (the module-scope
 * `db` singleton from ../db/client is mocked, same technique as Sprint 56B's returns/refunds
 * route tests), and authenticates with a real X-Noctella-ERP-Key matching ERP_INTEGRATION_KEY.
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

const ERP_KEY = "test-erp-key-57b";

describe("purchasing ERP routes (Sprint 57B)", () => {
  let server: Server;
  let baseUrl: string;
  let createCategory: typeof import("../src/services/categories").createCategory;
  let createProduct: typeof import("../src/services/products").createProduct;
  let createSupplier: typeof import("../src/services/erpPurchasingBridge").createSupplier;
  let createPurchase: typeof import("../src/services/erpPurchasingBridge").createPurchase;

  beforeAll(async () => {
    process.env.ERP_INTEGRATION_KEY = ERP_KEY;
    ({ createCategory } = await import("../src/services/categories"));
    ({ createProduct } = await import("../src/services/products"));
    ({ createSupplier, createPurchase } = await import("../src/services/erpPurchasingBridge"));
    const erpRouter = (await import("../src/routes/erp")).default;
    const app = express();
    app.use(express.json());
    app.use("/api/erp", erpRouter);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    // routes/erp.ts pulls in a much larger import graph (multer + every ERP bridge) than a
    // single-domain router, so under full-suite parallel worker contention the dynamic import
    // above can exceed vitest's default 10s hook timeout even though it's fast in isolation.
  }, 30_000);

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  function headers(extra: Record<string, string> = {}) {
    return { "content-type": "application/json", "X-Noctella-ERP-Key": ERP_KEY, "X-Noctella-ERP-Client-Version": "0.1.0", ...extra };
  }

  async function seedPurchase() {
    const category = await createCategory(harnessDb, { name: `Cat ${Math.random()}`, displayOrder: 0, isActive: true });
    const product = await createProduct(harnessDb, { sku: `SKU-${Math.random()}`, title: "Item", slug: `item-${Math.random()}`, type: ProductType.UniqueItem, status: ProductStatus.Draft, categoryId: category.id, stockQuantity: 0, priceEur: 100, purchaseCurrency: "EUR" } as any);
    const supplier: any = await createSupplier(harnessDb, { name: `Supplier ${Math.random()}`, supplierType: SupplierType.Dealer });
    const purchase: any = await createPurchase(harnessDb, { supplierId: supplier.id, sourceType: "Other", lines: [{ productId: product.id, titleSnapshot: "Item", quantity: 2, unitPurchaseCost: 10 }] });
    return purchase;
  }

  it("A: mark-ordered succeeds over real HTTP and persists Ordered status", async () => {
    const purchase = await seedPurchase();
    const res = await fetch(`${baseUrl}/api/erp/commands/purchases/${purchase.id}/mark-ordered`, { method: "POST", headers: headers(), body: JSON.stringify({ idempotencyKey: "http-order-a" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("Ordered");
  });

  it("B: mark-ordered on an already-Ordered purchase maps to 400 with the real backend message", async () => {
    const purchase = await seedPurchase();
    await fetch(`${baseUrl}/api/erp/commands/purchases/${purchase.id}/mark-ordered`, { method: "POST", headers: headers(), body: JSON.stringify({ idempotencyKey: "http-order-b1" }) });
    const res = await fetch(`${baseUrl}/api/erp/commands/purchases/${purchase.id}/mark-ordered`, { method: "POST", headers: headers(), body: JSON.stringify({ idempotencyKey: "http-order-b2" }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid purchase status transition/i);
  });

  it("C: mark-ordered on a missing purchase maps to 404", async () => {
    const res = await fetch(`${baseUrl}/api/erp/commands/purchases/does-not-exist/mark-ordered`, { method: "POST", headers: headers(), body: JSON.stringify({ idempotencyKey: "http-order-c" }) });
    expect(res.status).toBe(404);
  });

  it("D: mark-ordered without an ERP key is rejected with 401 and performs no mutation", async () => {
    const purchase = await seedPurchase();
    const res = await fetch(`${baseUrl}/api/erp/commands/purchases/${purchase.id}/mark-ordered`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: "http-order-d" }) });
    expect(res.status).toBe(401);
    const check = await fetch(`${baseUrl}/api/erp/purchases/${purchase.id}`, { headers: headers() });
    expect((await check.json()).status).toBe("Draft");
  });

  it("E: cancel succeeds over real HTTP for a Draft purchase", async () => {
    const purchase = await seedPurchase();
    const res = await fetch(`${baseUrl}/api/erp/commands/purchases/${purchase.id}/cancel`, { method: "POST", headers: headers(), body: JSON.stringify({ idempotencyKey: "http-cancel-e" }) });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("Cancelled");
  });

  it("F: cancel is rejected over real HTTP for a Received purchase with 400, not a generic 500", async () => {
    const purchase = await seedPurchase();
    await fetch(`${baseUrl}/api/erp/commands/purchases/${purchase.id}/receive`, { method: "POST", headers: headers(), body: JSON.stringify({ idempotencyKey: "http-recv-f", payload: { lines: [{ purchaseLineId: purchase.lines[0].id, quantityReceived: 2 }] } }) });
    const res = await fetch(`${baseUrl}/api/erp/commands/purchases/${purchase.id}/cancel`, { method: "POST", headers: headers(), body: JSON.stringify({ idempotencyKey: "http-cancel-f" }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/cannot be cancelled|status transition/i);
    const check = await fetch(`${baseUrl}/api/erp/purchases/${purchase.id}`, { headers: headers() });
    expect((await check.json()).status).toBe("Received");
  });
});
