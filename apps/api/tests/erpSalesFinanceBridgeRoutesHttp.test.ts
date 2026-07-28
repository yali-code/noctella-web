import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import express from "express";
import { OrderStatus, PaymentProvider, PaymentStatus, PriceCurrency, ProductStatus, ProductType } from "@noctella/shared";

/**
 * Sprint 79 requirement I: real Express HTTP tests for the company-profile and invoice ERP
 * routes, none of which had route-level (as opposed to direct service-call) coverage before this
 * correction. Mounts the real apps/api/src/routes/erp.ts router in an isolated Express app over an
 * isolated in-memory SQLite db (the module-scope `db` singleton from ../db/client is mocked, same
 * technique as Sprint 57B's purchasing route tests), and authenticates with a real
 * X-Noctella-ERP-Key matching ERP_INTEGRATION_KEY.
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

const ERP_KEY = "test-erp-key-79-http";
const address = { fullName: "Jane Collector", line1: "1 Rue Noctella", city: "Paris", postalCode: "75001", country: "FR" };
const fictionalProfile = { legalName: "Noctella Test Trading Ltd.", registrationNumber: "TEST-UIC-HTTP", vatNumber: "TESTVATHTTP", addressLine1: "1 Test Warehouse Row", city: "Testville", postalCode: "00000", country: "FR", email: "billing@example-noctella-http.invalid", phone: "+00 000 000 000", defaultVatRate: 0 };

describe("Sprint 79: company-profile and invoice ERP routes over real HTTP", () => {
  let server: Server;
  let baseUrl: string;
  let createCategory: typeof import("../src/services/categories").createCategory;
  let createProduct: typeof import("../src/services/products").createProduct;
  let createPaymentSession: typeof import("../src/payments/paymentRepository").createPaymentSession;
  let createOrder: typeof import("../src/services/orders").createOrder;
  let upsertCompanyProfile: typeof import("../src/services/companyProfile").upsertCompanyProfile;
  let seq = 0;

  beforeAll(async () => {
    process.env.ERP_INTEGRATION_KEY = ERP_KEY;
    ({ createCategory } = await import("../src/services/categories"));
    ({ createProduct } = await import("../src/services/products"));
    ({ createPaymentSession } = await import("../src/payments/paymentRepository"));
    ({ createOrder } = await import("../src/services/orders"));
    ({ upsertCompanyProfile } = await import("../src/services/companyProfile"));
    const erpRouter = (await import("../src/routes/erp")).default;
    const app = express();
    app.use(express.json());
    app.use("/api/erp", erpRouter);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    await upsertCompanyProfile(harnessDb, fictionalProfile);
  }, 30_000);

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  function headers(extra: Record<string, string> = {}) {
    return { "content-type": "application/json", "X-Noctella-ERP-Key": ERP_KEY, "X-Noctella-ERP-Client-Version": "0.1.0", ...extra };
  }

  async function seedPaidOrderWithInvoice() {
    seq += 1;
    const cat = await createCategory(harnessDb, { name: `Cat-HTTP-${seq}`, displayOrder: 0, isActive: true });
    const product = await createProduct(harnessDb, { sku: `SKU-HTTP-${seq}`, title: `Product ${seq}`, slug: `product-http-${seq}`, type: ProductType.UniqueItem, status: ProductStatus.Published, categoryId: cat.id, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false, priceEur: 100, stockQuantity: 1, images: [] });
    const ref = `http-ref-${seq}`;
    await createPaymentSession(harnessDb, { provider: PaymentProvider.Stripe, providerReference: ref, status: PaymentStatus.Paid, amount: 100, currency: "EUR", idempotencyKey: `http-pay-${seq}` });
    const order = await createOrder(harnessDb, { orderDraftId: `http-draft-${seq}`, guestEmail: "jane@example.com", status: OrderStatus.Processing, paymentStatus: PaymentStatus.Paid, paymentProvider: PaymentProvider.Stripe, paymentReference: ref, currency: PriceCurrency.Eur, billingAddress: address, shippingAddress: address, subtotalAmount: 100, totalAmount: 100, items: [{ productId: product.id, quantity: 1 as const }] });
    const listRes = await fetch(`${baseUrl}/api/erp/orders/${order.id}/invoices`, { headers: headers() });
    const invoice = (await listRes.json()).items[0];
    return { order, invoice };
  }

  it("GET company profile returns the configured profile over real HTTP", async () => {
    const res = await fetch(`${baseUrl}/api/erp/company-profile`, { headers: headers() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.legalName).toBe(fictionalProfile.legalName);
  });

  it("update company profile persists a field change over real HTTP", async () => {
    const res = await fetch(`${baseUrl}/api/erp/commands/company-profile/update`, { method: "POST", headers: headers(), body: JSON.stringify({ payload: { tradeName: "Noctella HTTP Trade Name" } }) });
    expect(res.status).toBe(200);
    expect((await res.json()).tradeName).toBe("Noctella HTTP Trade Name");
  });

  it("update company profile rejects a malformed numeric payload (non-numeric VAT rate string) with 400, not silently coerced", async () => {
    const res = await fetch(`${baseUrl}/api/erp/commands/company-profile/update`, { method: "POST", headers: headers(), body: JSON.stringify({ payload: { defaultVatRate: "not-a-number" } }) });
    expect(res.status).toBe(400);
    const profile = await (await fetch(`${baseUrl}/api/erp/company-profile`, { headers: headers() })).json();
    expect(profile.defaultVatRate).not.toBeNaN();
    expect(typeof profile.defaultVatRate).toBe("number");
  });

  it("GET invoices (list) and GET invoice detail both succeed over real HTTP", async () => {
    const { order, invoice } = await seedPaidOrderWithInvoice();
    const listRes = await fetch(`${baseUrl}/api/erp/invoices?orderId=${order.id}`, { headers: headers() });
    expect(listRes.status).toBe(200);
    expect((await listRes.json()).items).toHaveLength(1);
    const detailRes = await fetch(`${baseUrl}/api/erp/invoices/${invoice.id}`, { headers: headers() });
    expect(detailRes.status).toBe(200);
    expect((await detailRes.json()).id).toBe(invoice.id);
  });

  it("update Draft invoice succeeds over real HTTP and recalculates totals", async () => {
    const { invoice } = await seedPaidOrderWithInvoice();
    const res = await fetch(`${baseUrl}/api/erp/commands/invoices/${invoice.id}/update`, { method: "POST", headers: headers(), body: JSON.stringify({ idempotencyKey: `http-upd-${invoice.id}`, payload: { shippingAmount: 10 } }) });
    expect(res.status).toBe(200);
    expect((await res.json()).shippingAmount).toBe(10);
  });

  it("update Draft line succeeds over real HTTP", async () => {
    const { invoice } = await seedPaidOrderWithInvoice();
    const line = invoice.lines?.[0] ?? (await (await fetch(`${baseUrl}/api/erp/invoices/${invoice.id}`, { headers: headers() })).json()).lines[0];
    const res = await fetch(`${baseUrl}/api/erp/commands/invoices/${invoice.id}/lines/${line.id}/update`, { method: "POST", headers: headers(), body: JSON.stringify({ idempotencyKey: `http-line-${line.id}`, payload: { titleSnapshot: "Renamed via HTTP" } }) });
    expect(res.status).toBe(200);
    expect((await res.json()).lines[0].titleSnapshot).toBe("Renamed via HTTP");
  });

  it("switch calculation mode succeeds over real HTTP", async () => {
    const { invoice } = await seedPaidOrderWithInvoice();
    const res = await fetch(`${baseUrl}/api/erp/commands/invoices/${invoice.id}/calculation-mode`, { method: "POST", headers: headers(), body: JSON.stringify({ idempotencyKey: `http-mode-${invoice.id}`, payload: { calculationMode: "ManualOverride" } }) });
    expect(res.status).toBe(200);
    expect((await res.json()).calculationMode).toBe("ManualOverride");
  });

  it("recalculate succeeds over real HTTP", async () => {
    const { invoice } = await seedPaidOrderWithInvoice();
    const res = await fetch(`${baseUrl}/api/erp/commands/invoices/${invoice.id}/recalculate`, { method: "POST", headers: headers(), body: JSON.stringify({ idempotencyKey: `http-recalc-${invoice.id}` }) });
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(invoice.id);
  });

  it("refresh seller snapshot succeeds over real HTTP", async () => {
    const { invoice } = await seedPaidOrderWithInvoice();
    const res = await fetch(`${baseUrl}/api/erp/commands/invoices/${invoice.id}/refresh-seller-snapshot`, { method: "POST", headers: headers(), body: JSON.stringify({ idempotencyKey: `http-snap-${invoice.id}` }) });
    expect(res.status).toBe(200);
    expect(JSON.parse((await res.json()).sellerSnapshot).legalName).toBe(fictionalProfile.legalName);
  });

  it("issue readiness reports ready over real HTTP for a fully configured Draft", async () => {
    const { invoice } = await seedPaidOrderWithInvoice();
    const res = await fetch(`${baseUrl}/api/erp/invoices/${invoice.id}/issue-readiness`, { headers: headers() });
    expect(res.status).toBe(200);
    expect((await res.json()).ready).toBe(true);
  });

  it("issue invoice succeeds over real HTTP and assigns a sequential invoice number", async () => {
    const { invoice } = await seedPaidOrderWithInvoice();
    const res = await fetch(`${baseUrl}/api/erp/commands/invoices/${invoice.id}/issue`, { method: "POST", headers: headers(), body: JSON.stringify({ idempotencyKey: `http-issue-${invoice.id}` }) });
    expect(res.status).toBe(200);
    expect((await res.json()).invoiceNumber).toMatch(/^NOCT-\d{4}-\d{6}$/);
  });

  it("a request without an ERP key is rejected with 401 and performs no mutation", async () => {
    const { invoice } = await seedPaidOrderWithInvoice();
    const res = await fetch(`${baseUrl}/api/erp/commands/invoices/${invoice.id}/update`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: `http-noauth-${invoice.id}`, payload: { shippingAmount: 99 } }) });
    expect(res.status).toBe(401);
    const check = await fetch(`${baseUrl}/api/erp/invoices/${invoice.id}`, { headers: headers() });
    expect((await check.json()).shippingAmount).not.toBe(99);
  });

  it("a command missing idempotencyKey is rejected with 400", async () => {
    const { invoice } = await seedPaidOrderWithInvoice();
    const res = await fetch(`${baseUrl}/api/erp/commands/invoices/${invoice.id}/recalculate`, { method: "POST", headers: headers(), body: JSON.stringify({}) });
    expect(res.status).toBe(400);
  });

  it("a stale optimistic-concurrency value (expectedUpdatedAt) on an update is rejected with 409", async () => {
    const { invoice } = await seedPaidOrderWithInvoice();
    const res = await fetch(`${baseUrl}/api/erp/commands/invoices/${invoice.id}/update`, { method: "POST", headers: headers(), body: JSON.stringify({ idempotencyKey: `http-stale-${invoice.id}`, payload: { expectedUpdatedAt: "not-the-real-timestamp", notes: "should not apply" } }) });
    expect(res.status).toBe(409);
  });

  it("a malformed numeric payload (non-numeric shipping amount string) on an invoice update is rejected with 400, not silently coerced to 0/NaN", async () => {
    const { invoice } = await seedPaidOrderWithInvoice();
    const res = await fetch(`${baseUrl}/api/erp/commands/invoices/${invoice.id}/update`, { method: "POST", headers: headers(), body: JSON.stringify({ idempotencyKey: `http-badnum-${invoice.id}`, payload: { shippingAmount: "not-a-number" } }) });
    expect(res.status).toBe(400);
    const check = await fetch(`${baseUrl}/api/erp/invoices/${invoice.id}`, { headers: headers() });
    const shippingAmount = (await check.json()).shippingAmount;
    expect(Number.isFinite(shippingAmount)).toBe(true);
  });
});
