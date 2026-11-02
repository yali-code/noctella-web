import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { ProductStatus, ProductType } from "@noctella/shared";
import { aiIntakeProposals, aiProductIntakes, invoiceCostSetItems, invoiceCostSets, invoiceIntakes, products, purchaseAllocations, purchaseLines, purchases, stockMovements } from "../src/db/schema.sqlite";
import { executePurchaseCommand } from "../src/services/erpPurchasingBridge";
import { ConflictError, InvoiceCostSetBlockedError, NotFoundError, BadRequestError, FxRateUnavailableError } from "../src/services/errors";
import {
  approveInvoiceCostSet,
  cancelInvoiceCostSet,
  createInvoiceCostSet,
  getInvoiceCostSet,
  listInvoiceCostSetProductCandidates,
  previewInvoiceCostSetAllocation,
  reviewInvoiceIntake,
  setInvoiceCostSetProducts,
  setInvoiceIntakeBankDebit,
} from "../src/services/invoiceIntakes";
import type { FxRateLookup } from "../src/services/ecbReferenceRates";
import { createTestDb } from "./testDb";

/**
 * PHASE-2C: bank debit + official rate, product selection, preview and approve -> Draft purchase, over a real
 * in-memory SQLite db. The ECB lookup is mocked; the canonical purchase command path is the real
 * executePurchaseCommand wrapped in a spy.
 */
const f = <T>(value: T | null) => ({ value, evidence: value === null ? null : String(value), confidence: 0.95 });
const header = (o: { type: string; number: string; paid: string; total: number; supplier: string; issue: string }) => ({
  invoiceType: f(o.type), supplierName: f(o.supplier), supplierVatNumber: f(null), platform: f(null), invoiceNumber: f(o.number),
  issueDate: f(o.issue), dueDate: f(null), paidDate: f(o.paid), currency: f("SEK"), vatNote: f(null), reverseCharge: f(null), total: f(o.total),
});
const AUCTION = {
  ...header({ type: "auction", number: "227552", paid: "2026-09-18", total: 1198, supplier: "Växjö Auktionskammare", issue: "2026-09-15" }),
  lots: [{ lotNumber: f("5332164"), title: f("KAMEROR, 8 st"), itemCountHint: f(8), amount: f(945) }],
  fees: [
    { type: f("hammer_fee"), label: f("Hammer fee"), amount: f(64), percent: f(null), lotNumber: f("5332164") },
    { type: f("buyer_premium"), label: f("Buyer's premium"), amount: f(189), percent: f(20), lotNumber: f("5332164") },
  ],
};
const TRANSPORT = {
  ...header({ type: "transport", number: "228073", paid: "2026-09-23", total: 408, supplier: "Auctionet Shipping", issue: "2026-09-22" }),
  lots: [{ lotNumber: f("5332164"), title: f("Home delivery"), itemCountHint: f(null), amount: f(408) }],
  fees: [],
};
const RATES: Record<string, number> = { "2026-09-18": 11.0625, "2026-09-23": 11.08 };
const fxRate: FxRateLookup = vi.fn(async (currency: string, paidDate: string) => ({ rate: RATES[paidDate], rateDate: paidDate, source: "ECB" as const }));
const WEIGHTS = [120, 80, 45, 45, 30, 25, 15, 10];

let db: ReturnType<typeof createTestDb>;
const execute = vi.fn(executePurchaseCommand);

async function seedProduct(n: number, suggestedPriceEur: number | null, purchaseCost: number | null = null) {
  const id = `prod-${n}-${randomUUID().slice(0, 6)}`;
  await db.insert(products).values({ id, slug: id, sku: `CAM-${n}`, title: `Camera ${n}`, type: ProductType.UniqueItem, status: ProductStatus.Draft, purchaseCost, createdAt: `2026-10-0${Math.min(n, 9)}T10:00:00.000Z` } as any);
  const intakeId = randomUUID();
  await db.insert(aiProductIntakes).values({ id: intakeId, status: "finalized", createdByAdminUserId: "admin-1", resultProductId: id } as any);
  await db.insert(aiIntakeProposals).values({ id: randomUUID(), intakeId, suggestedPriceEur, photoSetFingerprint: "fp", generatedAt: "2026-10-01T00:00:00.000Z", providerName: "mock", promptVersion: "v1" } as any);
  return id;
}

let seq = 0;
async function seedIntake(costSetId: string, invoiceType: string, output: unknown) {
  const id = randomUUID();
  const o: any = output;
  // Distinct, increasing created_at so the intakes read back in seeding order.
  const t = new Date(Date.UTC(2026, 10, 2, 10, 0, seq++)).toISOString();
  await db.insert(invoiceIntakes).values({
    id, costSetId, invoiceType, status: "reviewed", fileRelativePath: `${costSetId}/${id}.pdf`, fileSha256: randomUUID().replace(/-/g, "").padEnd(64, "0"), fileSizeBytes: 100, fileMime: "application/pdf",
    invoiceNumber: o.invoiceNumber.value, supplierName: o.supplierName.value, issueDate: o.issueDate.value, paidDate: o.paidDate.value, currency: "SEK", totalOriginal: o.total.value,
    extractionJson: JSON.stringify({ output, checks: [], model: "m", extractedAt: "2026-11-02T00:00:00.000Z" }),
    createdAt: t, updatedAt: t,
  } as any);
  return id;
}

async function readySet() {
  const set = await createInvoiceCostSet(db as any, { title: "Växjö 227552" });
  const auctionId = await seedIntake(set.id as string, "auction", AUCTION);
  const transportId = await seedIntake(set.id as string, "transport", TRANSPORT);
  const productIds: string[] = [];
  for (const [k, w] of WEIGHTS.entries()) productIds.push(await seedProduct(k + 1, w));
  return { setId: set.id as string, auctionId, transportId, productIds };
}

async function fullyPrepared() {
  const ctx = await readySet();
  await setInvoiceIntakeBankDebit(db as any, ctx.auctionId, 109.65, fxRate);
  await setInvoiceIntakeBankDebit(db as any, ctx.transportId, 37.12, fxRate);
  await setInvoiceCostSetProducts(db as any, ctx.setId, ctx.productIds.map((productId) => ({ productId })));
  return ctx;
}

beforeEach(() => {
  db = createTestDb();
  execute.mockClear();
  execute.mockImplementation(executePurchaseCommand);
});

describe("bank debit + official rate (PHASE-2C)", () => {
  it("stores the rate, rate date, source and bank debit; re-running overwrites both", async () => {
    const { auctionId } = await readySet();
    const out: any = await setInvoiceIntakeBankDebit(db as any, auctionId, 109.65, fxRate);
    expect(out).toMatchObject({ fxRate: 11.0625, fxRateDate: "2026-09-18", fxSource: "ECB", bankDebitEur: 109.65, fx: { officialEur: 108.29, fxDiffEur: 1.36 } });
    expect(fxRate).toHaveBeenCalledWith("SEK", "2026-09-18");
    const again: any = await setInvoiceIntakeBankDebit(db as any, auctionId, 110, async () => ({ rate: 11, rateDate: "2026-09-17", source: "ECB" }));
    expect(again).toMatchObject({ fxRate: 11, fxRateDate: "2026-09-17", bankDebitEur: 110 });
  });

  it("refuses a non-reviewed intake, an 'other' invoice, a missing paid date, a non-positive debit and a non-open set; FX failure stores nothing", async () => {
    const { setId, auctionId } = await readySet();
    await expect(setInvoiceIntakeBankDebit(db as any, auctionId, 0, fxRate)).rejects.toBeInstanceOf(BadRequestError);
    await expect(setInvoiceIntakeBankDebit(db as any, auctionId, 10, async () => { throw new FxRateUnavailableError(); })).rejects.toBeInstanceOf(FxRateUnavailableError);
    expect((await db.select().from(invoiceIntakes).where(eq(invoiceIntakes.id, auctionId)))[0]).toMatchObject({ fxRate: null, bankDebitEur: null });

    const other = await seedIntake(setId, "other", { ...TRANSPORT, invoiceType: f("other") });
    await expect(setInvoiceIntakeBankDebit(db as any, other, 10, fxRate)).rejects.toBeInstanceOf(BadRequestError);
    const noPaid = await seedIntake(setId, "transport", { ...TRANSPORT, invoiceNumber: f("x"), paidDate: f(null) });
    await db.update(invoiceIntakes).set({ paidDate: null }).where(eq(invoiceIntakes.id, noPaid));
    await expect(setInvoiceIntakeBankDebit(db as any, noPaid, 10, fxRate)).rejects.toBeInstanceOf(BadRequestError);
    await db.update(invoiceIntakes).set({ status: "extracted" }).where(eq(invoiceIntakes.id, auctionId));
    await expect(setInvoiceIntakeBankDebit(db as any, auctionId, 10, fxRate)).rejects.toBeInstanceOf(ConflictError);
    await cancelInvoiceCostSet(db as any, setId);
    await expect(setInvoiceIntakeBankDebit(db as any, noPaid, 10, fxRate)).rejects.toBeInstanceOf(ConflictError);
  });

  it("a later review clears the official rate (values may have changed) but keeps the bank debit", async () => {
    const { auctionId } = await readySet();
    await setInvoiceIntakeBankDebit(db as any, auctionId, 109.65, fxRate);
    const reviewed: any = await reviewInvoiceIntake(db as any, auctionId, { edits: { paidDate: "2026-09-19" }, confirm: true });
    expect(reviewed).toMatchObject({ fxRate: null, fxRateDate: null, fxSource: null, bankDebitEur: 109.65, paidDate: "2026-09-19" });
  });
});

describe("product selection and weights (PHASE-2C)", () => {
  it("defaults the weight to the AI suggested price, an admin value overrides it, and a missing AI price stays empty", async () => {
    const { setId, productIds } = await readySet();
    const noAi = await seedProduct(9, null);
    const out = await setInvoiceCostSetProducts(db as any, setId, [{ productId: productIds[0] }, { productId: productIds[1], valueWeightEur: 99.5 }, { productId: noAi }]);
    expect(out.items.map((i) => [i.sku, i.valueWeightEur, i.weightSource])).toEqual([["CAM-1", 120, "ai"], ["CAM-2", 99.5, "admin"], ["CAM-9", null, null]]);
    const preview = await previewInvoiceCostSetAllocation(db as any, setId);
    expect(preview.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["MISSING_WEIGHT", "MISSING_RATE", "MISSING_BANK_DEBIT"]));
  });

  it("rejects duplicates, unknown products, a product on a non-cancelled purchase line and a product in another open set", async () => {
    const { setId, productIds } = await readySet();
    await expect(setInvoiceCostSetProducts(db as any, setId, [{ productId: productIds[0] }, { productId: productIds[0] }])).rejects.toBeInstanceOf(BadRequestError);
    await expect(setInvoiceCostSetProducts(db as any, setId, [{ productId: "missing" }])).rejects.toBeInstanceOf(NotFoundError);

    await executePurchaseCommand(db as any, "test-client", { idempotencyKey: "seed-1", payload: { currency: "EUR", lines: [{ productId: productIds[0], titleSnapshot: "x", quantity: 1, unitPurchaseCost: 5 }] } }, "CreatePurchase");
    await expect(setInvoiceCostSetProducts(db as any, setId, [{ productId: productIds[0] }])).rejects.toThrow(/Already on a purchase: CAM-1/);

    const other = await createInvoiceCostSet(db as any, { title: "Other" });
    await setInvoiceCostSetProducts(db as any, other.id as string, [{ productId: productIds[1] }]);
    await expect(setInvoiceCostSetProducts(db as any, setId, [{ productId: productIds[1] }])).rejects.toThrow(/another open or approved cost set: CAM-2/);
    // A cancelled set releases its products; a cancelled purchase does too.
    await cancelInvoiceCostSet(db as any, other.id as string);
    await expect(setInvoiceCostSetProducts(db as any, setId, [{ productId: productIds[1] }])).resolves.toBeTruthy();
    await db.update(purchases).set({ status: "Cancelled" });
    await expect(setInvoiceCostSetProducts(db as any, setId, [{ productId: productIds[0] }])).resolves.toBeTruthy();
  });

  it("lists AI-intake candidates newest first, searchable by SKU/title, excluding products on a purchase or in another open set", async () => {
    const { setId, productIds } = await readySet();
    await db.insert(products).values({ id: "manual", slug: "manual", sku: "MAN-1", title: "Manual camera", type: ProductType.UniqueItem, status: ProductStatus.Draft } as any);
    await executePurchaseCommand(db as any, "test-client", { idempotencyKey: "seed-2", payload: { currency: "EUR", lines: [{ productId: productIds[0], titleSnapshot: "x", quantity: 1, unitPurchaseCost: 5 }] } }, "CreatePurchase");
    const other = await createInvoiceCostSet(db as any, { title: "Other" });
    await setInvoiceCostSetProducts(db as any, other.id as string, [{ productId: productIds[1] }]);

    const all = (await listInvoiceCostSetProductCandidates(db as any, setId, "")).items;
    expect(all.map((c) => c.sku)).toEqual(["CAM-8", "CAM-7", "CAM-6", "CAM-5", "CAM-4", "CAM-3"]);
    expect(all[0]).toMatchObject({ title: "Camera 8", aiSuggestedPriceEur: 10, createdAt: "2026-10-08T10:00:00.000Z" });
    expect((await listInvoiceCostSetProductCandidates(db as any, setId, "cam-5")).items.map((c) => c.sku)).toEqual(["CAM-5"]);
    expect((await listInvoiceCostSetProductCandidates(db as any, setId, "camera 3")).items.map((c) => c.sku)).toEqual(["CAM-3"]);
  });
});

describe("preview (PHASE-2C)", () => {
  it("returns the breakdown, sums exactly to the bank debits and persists alloc_* on the items", async () => {
    const { setId } = await fullyPrepared();
    const preview = await previewInvoiceCostSetAllocation(db as any, setId);
    expect(preview.issues).toEqual([]);
    expect(preview.totalBankDebitEur).toBe(146.77);
    expect(preview.totalAllocatedEur).toBe(146.77);
    expect(preview.intakes.map((i) => [i.invoiceNumber, i.officialEur, i.bankDebitEur, i.fxDiffEur])).toEqual([["227552", 108.29, 109.65, 1.36], ["228073", 36.82, 37.12, 0.3]]);
    const rows = await db.select().from(invoiceCostSetItems).where(eq(invoiceCostSetItems.costSetId, setId));
    expect(Math.round(rows.reduce((a, r) => a + (r.allocTotalEur as number) * 100, 0))).toBe(14677);
    const detail: any = await getInvoiceCostSet(db as any, setId);
    expect(detail.items).toHaveLength(8);
    expect(detail.items[0]).toMatchObject({ sku: "CAM-1", weightSource: "ai", allocTotalEur: preview.items[0].totalEur });
    expect(detail.intakes.find((i: any) => i.invoiceType === "auction").fx).toEqual({ officialEur: 108.29, fxDiffEur: 1.36 });
  });

  it("warns when a product already has a purchase cost", async () => {
    const { setId } = await fullyPrepared();
    const extra = await seedProduct(9, 5, 40);
    const current = (await getInvoiceCostSet(db as any, setId) as any).items.map((i: any) => ({ productId: i.productId }));
    await setInvoiceCostSetProducts(db as any, setId, [...current, { productId: extra }]);
    const preview = await previewInvoiceCostSetAllocation(db as any, setId);
    expect(preview.issues).toEqual([]);
    expect(preview.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["PURCHASE_COST_ALREADY_SET", "ITEM_COUNT_MISMATCH"]));
  });
});

describe("approve -> Draft purchase (PHASE-2C)", () => {
  it("creates exactly one Draft purchase via CreatePurchase then AllocatePurchaseCosts Equal, with no header fees and no stock movement", async () => {
    const { setId, productIds } = await fullyPrepared();
    const preview = await previewInvoiceCostSetAllocation(db as any, setId);
    const approved: any = await approveInvoiceCostSet(db as any, setId, { clientId: "test-client" }, execute);

    expect(execute.mock.calls.map((c) => c[3])).toEqual(["CreatePurchase", "AllocatePurchaseCosts"]);
    const [createCall, allocateCall] = execute.mock.calls;
    expect(createCall[1]).toBe("test-client");
    expect(createCall[2].payload).toMatchObject({
      erpReferenceId: `invoice-cost-set:${setId}`, sourceType: "Auction", currency: "EUR", invoiceReferenceNumber: "227552, 228073",
      auctionHouse: "Växjö Auktionskammare", auctionDate: "2026-09-15", buyerPremium: 0, shippingCost: 0, customsCost: 0, packagingCost: 0, taxVat: 0, miscellaneousCost: 0,
    });
    expect(createCall[2].payload.notes).toContain("auction 227552: 1198.00 SEK @ ECB 11.0625 (2026-09-18) = official 108.29 EUR; bank 109.65 EUR; FX diff +1.36 EUR");
    expect(createCall[2].payload.notes).toContain(`Invoice cost set ${setId}`);
    expect(allocateCall[2].payload).toEqual({ allocationMethod: "Equal" });

    const all = await db.select().from(purchases);
    expect(all).toHaveLength(1);
    const [purchase] = all;
    expect(purchase).toMatchObject({ id: approved.purchaseId, status: "Draft", currency: "EUR", buyerPremium: 0, shippingCost: 0 });
    expect(Math.round(purchase.itemSubtotal * 100)).toBe(14677);
    expect(Math.round((purchase.totalCost as number) * 100)).toBe(14677);
    const lines = await db.select().from(purchaseLines).where(eq(purchaseLines.purchaseId, purchase.id));
    expect(lines).toHaveLength(8);
    const first = lines.find((l) => l.productId === productIds[0])!;
    expect(first).toMatchObject({ titleSnapshot: "Camera 1 [CAM-1]", quantity: 1, receivedQuantity: 0, unitPurchaseCost: preview.items[0].totalEur, sourceLineReference: "5332164" });
    const allocations = await db.select().from(purchaseAllocations).where(eq(purchaseAllocations.purchaseId, purchase.id));
    expect(allocations).toHaveLength(8);
    for (const a of allocations) expect(a.allocatedTotalCost).toBe(lines.find((l) => l.id === a.purchaseLineId)!.unitPurchaseCost);
    expect((await db.select().from(products).where(eq(products.id, productIds[0])))[0].purchaseCost).toBe(preview.items[0].totalEur);
    expect(await db.select().from(stockMovements)).toHaveLength(0);

    expect(approved).toMatchObject({ status: "approved", purchaseId: purchase.id, approvedBy: "admin" });
    expect(approved.approvedAt).toBeTruthy();
  });

  it("after approve the set is read-only: approve again, cancel, products, preview and bank debit are refused", async () => {
    const { setId, auctionId, productIds } = await fullyPrepared();
    await approveInvoiceCostSet(db as any, setId, { clientId: "test-client" }, execute);
    await expect(approveInvoiceCostSet(db as any, setId, { clientId: "test-client" }, execute)).rejects.toBeInstanceOf(ConflictError);
    await expect(cancelInvoiceCostSet(db as any, setId)).rejects.toBeInstanceOf(ConflictError);
    await expect(setInvoiceCostSetProducts(db as any, setId, [{ productId: productIds[0] }])).rejects.toBeInstanceOf(ConflictError);
    await expect(previewInvoiceCostSetAllocation(db as any, setId)).rejects.toBeInstanceOf(ConflictError);
    await expect(setInvoiceIntakeBankDebit(db as any, auctionId, 1, fxRate)).rejects.toBeInstanceOf(ConflictError);
    expect(await db.select().from(purchases)).toHaveLength(1);
    // The approved set still holds its products for other sets.
    const other = await createInvoiceCostSet(db as any, { title: "Other" });
    await expect(setInvoiceCostSetProducts(db as any, other.id as string, [{ productId: productIds[2] }])).rejects.toBeInstanceOf(ConflictError);
  });

  it("is blocked (409 with issues) while the preview has issues, and creates nothing", async () => {
    const { setId, productIds } = await readySet();
    await setInvoiceCostSetProducts(db as any, setId, productIds.map((productId) => ({ productId })));
    const err = await approveInvoiceCostSet(db as any, setId, { clientId: "test-client" }, execute).catch((e) => e);
    expect(err).toBeInstanceOf(InvoiceCostSetBlockedError);
    expect(err.issues.map((i: any) => i.code)).toEqual(expect.arrayContaining(["MISSING_RATE", "MISSING_BANK_DEBIT"]));
    expect(execute).not.toHaveBeenCalled();
    expect(await db.select().from(purchases)).toHaveLength(0);
  });

  it("a retry after a failure between purchase creation and the set update reuses the purchase (no duplicate)", async () => {
    const { setId } = await fullyPrepared();
    execute.mockImplementationOnce(executePurchaseCommand).mockImplementationOnce(async (...args: Parameters<typeof executePurchaseCommand>) => {
      await executePurchaseCommand(...args);
      throw new Error("simulated crash after allocate, before the set update");
    });
    await expect(approveInvoiceCostSet(db as any, setId, { clientId: "test-client" }, execute)).rejects.toThrow(/simulated crash/);
    expect((await db.select().from(invoiceCostSets).where(eq(invoiceCostSets.id, setId)))[0].status).toBe("open");
    expect(await db.select().from(purchases)).toHaveLength(1);

    execute.mockClear();
    const approved: any = await approveInvoiceCostSet(db as any, setId, { clientId: "test-client" }, execute);
    expect(execute.mock.calls.map((c) => c[3])).toEqual(["AllocatePurchaseCosts"]);
    const all = await db.select().from(purchases);
    expect(all).toHaveLength(1);
    expect(approved).toMatchObject({ status: "approved", purchaseId: all[0].id });
  });

  it("a retry after a failure right after CreatePurchase also reuses it", async () => {
    const { setId } = await fullyPrepared();
    execute.mockImplementationOnce(executePurchaseCommand).mockImplementationOnce(async () => { throw new Error("allocate failed"); });
    await expect(approveInvoiceCostSet(db as any, setId, { clientId: "test-client" }, execute)).rejects.toThrow(/allocate failed/);
    const approved: any = await approveInvoiceCostSet(db as any, setId, { clientId: "test-client" }, execute);
    const all = await db.select().from(purchases);
    expect(all).toHaveLength(1);
    expect(approved.purchaseId).toBe(all[0].id);
    expect(await db.select().from(purchaseAllocations).where(eq(purchaseAllocations.purchaseId, all[0].id))).toHaveLength(8);
  });

  it("refuses to reuse an existing purchase whose lines no longer match the selection", async () => {
    const { setId, productIds } = await fullyPrepared();
    execute.mockImplementationOnce(executePurchaseCommand).mockImplementationOnce(async () => { throw new Error("allocate failed"); });
    await expect(approveInvoiceCostSet(db as any, setId, { clientId: "test-client" }, execute)).rejects.toThrow();
    await setInvoiceCostSetProducts(db as any, setId, productIds.map((productId, k) => ({ productId, valueWeightEur: k === 0 ? 500 : undefined })));
    await expect(approveInvoiceCostSet(db as any, setId, { clientId: "test-client" }, execute)).rejects.toThrow(/already exists .* with different lines/);
    expect(await db.select().from(purchases)).toHaveLength(1);
  });
});
