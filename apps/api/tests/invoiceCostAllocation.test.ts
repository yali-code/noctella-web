import { describe, expect, it } from "vitest";
import { allocateCostSet, invoiceComponents, largestRemainderSplit, type AllocationIntakeInput, type AllocationItemInput } from "../src/use-cases/invoice-intake/costAllocation";
import type { InvoiceValues } from "../src/use-cases/invoice-intake/invoiceReview";

/** PHASE-2C: pure allocation with the real set's numbers (auction 227552, transport 228073) and fixed mocked rates. */
const header = { supplierName: null, supplierVatNumber: null, platform: null, issueDate: null, dueDate: null, vatNote: null, reverseCharge: null };
const auctionValues = (): InvoiceValues => ({
  ...header, invoiceType: "auction", invoiceNumber: "227552", paidDate: "2026-09-18", currency: "SEK", total: 1198,
  lots: [{ lotNumber: "5332164", title: "KAMEROR, 8 st", itemCountHint: 8, amount: 945 }],
  fees: [{ type: "hammer_fee", label: "Hammer fee", amount: 64, percent: null, lotNumber: "5332164" }, { type: "buyer_premium", label: "Buyer's premium", amount: 189, percent: 20, lotNumber: "5332164" }],
});
// The AI put the 408 SEK home delivery under lots; transport = invoice total whatever the shape.
const transportValues = (): InvoiceValues => ({
  ...header, invoiceType: "transport", invoiceNumber: "228073", paidDate: "2026-09-23", currency: "SEK", total: 408,
  lots: [{ lotNumber: "5332164", title: "Home delivery", itemCountHint: null, amount: 408 }], fees: [],
});
const intake = (over: Partial<AllocationIntakeInput>): AllocationIntakeInput => ({
  id: "a", status: "reviewed", invoiceType: "auction", invoiceNumber: "227552", currency: "SEK", fxRate: 11.0625, fxRateDate: "2026-09-18", fxSource: "ECB", bankDebitEur: 109.65, values: auctionValues(), ...over,
});
const auction = () => intake({});
const transport = (bankDebitEur = 37.12) => intake({ id: "t", invoiceType: "transport", invoiceNumber: "228073", fxRate: 11.08, fxRateDate: "2026-09-23", bankDebitEur, values: transportValues() });
const WEIGHTS = [120, 80, 45, 45, 30, 25, 15, 10];
const products = (weights: Array<number | null> = WEIGHTS): AllocationItemInput[] =>
  weights.map((w, i) => ({ productId: `p${i + 1}`, sku: `SKU-${i + 1}`, title: `Camera ${i + 1}`, valueWeightEur: w, weightSource: "ai", purchaseCost: null }));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("largestRemainderSplit (PHASE-2C)", () => {
  it("sums exactly, follows the weights and is deterministic (ties to the lower index)", () => {
    expect(largestRemainderSplit(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(largestRemainderSplit(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
    expect(largestRemainderSplit(0, [5, 1])).toEqual([0, 0]);
    expect(largestRemainderSplit(10, [0, 3, 1])).toEqual([0, 8, 2]);
    const a = largestRemainderSplit(10829, WEIGHTS.map((w) => w * 100));
    expect(sum(a)).toBe(10829);
    expect(largestRemainderSplit(10829, WEIGHTS.map((w) => w * 100))).toEqual(a);
    expect(() => largestRemainderSplit(1, [0, 0])).toThrow();
  });
});

describe("allocateCostSet (PHASE-2C)", () => {
  it("auction components: lot + other fees, hammer, premium; transport = total", () => {
    expect(invoiceComponents("auction", auctionValues())).toEqual({ lot: 94500, hammer: 6400, premium: 18900, transport: 0, forwarder: 0 });
    expect(invoiceComponents("transport", transportValues())).toEqual({ lot: 0, hammer: 0, premium: 0, transport: 40800, forwarder: 0 });
    const withOther = { ...auctionValues(), fees: [...auctionValues().fees, { type: "other" as const, label: "Handling", amount: 10, percent: null, lotNumber: null }] };
    expect(invoiceComponents("auction", withOther).lot).toBe(95500);
  });

  it("the real set: per-invoice components sum to the official EUR, item totals sum exactly to the bank debits", () => {
    const r = allocateCostSet([auction(), transport()], products());
    expect(r.issues).toEqual([]);
    const [a, t] = r.intakes;
    expect(a.officialEurCents).toBe(Math.round((1198 / 11.0625) * 100)); // 10829
    expect(a.componentsCents.lot + a.componentsCents.hammer + a.componentsCents.premium).toBe(a.officialEurCents);
    expect(a.fxDiffCents).toBe(10965 - a.officialEurCents);
    expect(t.officialEurCents).toBe(Math.round((408 / 11.08) * 100)); // 3682
    expect(t.componentsCents.transport).toBe(t.officialEurCents);
    expect(t.fxDiffCents).toBe(3712 - t.officialEurCents);

    expect(r.totalBankDebitCents).toBe(10965 + 3712);
    expect(sum(r.items.map((i) => i.totalCents))).toBe(10965 + 3712);
    expect(sum(r.items.map((i) => i.lotCents))).toBe(a.componentsCents.lot);
    expect(sum(r.items.map((i) => i.hammerFeeCents))).toBe(a.componentsCents.hammer);
    expect(sum(r.items.map((i) => i.premiumCents))).toBe(a.componentsCents.premium);
    expect(sum(r.items.map((i) => i.transportCents))).toBe(t.componentsCents.transport);
    expect(sum(r.items.map((i) => i.fxDiffCents))).toBe(a.fxDiffCents + t.fxDiffCents);
    for (const i of r.items) expect(i.totalCents).toBe(i.lotCents + i.hammerFeeCents + i.premiumCents + i.transportCents + i.forwarderCents + i.fxDiffCents);
    for (const i of r.items) expect(i.totalCents).toBeGreaterThan(0);
  });

  it("the auction part follows the weights; transport is equal within 1 cent", () => {
    const r = allocateCostSet([auction(), transport()], products());
    const auctionPart = r.items.map((i) => i.lotCents + i.hammerFeeCents + i.premiumCents);
    const auctionTotal = sum(auctionPart);
    r.items.forEach((_, k) => expect(Math.abs(auctionPart[k] - (auctionTotal * WEIGHTS[k]) / sum(WEIGHTS))).toBeLessThanOrEqual(3));
    expect(auctionPart[0]).toBeGreaterThan(auctionPart[1]);
    expect(auctionPart[2]).toBe(auctionPart[3]);
    const transportPart = r.items.map((i) => i.transportCents);
    expect(Math.max(...transportPart) - Math.min(...transportPart)).toBeLessThanOrEqual(1);
  });

  it("a negative FX difference works and still sums exactly", () => {
    const r = allocateCostSet([auction(), transport(36.5)], products());
    expect(r.intakes[1].fxDiffCents).toBe(3650 - 3682);
    expect(r.intakes[1].fxDiffCents).toBeLessThan(0);
    expect(sum(r.items.map((i) => i.totalCents))).toBe(10965 + 3650);
  });

  it("is deterministic", () => {
    expect(allocateCostSet([auction(), transport()], products())).toEqual(allocateCostSet([auction(), transport()], products()));
  });

  it("EUR invoices (rate 1) have no FX difference beyond the bank debit", () => {
    const eurAuction = intake({ currency: "EUR", fxRate: 1, fxSource: "EUR", bankDebitEur: 1198, values: { ...auctionValues(), currency: "EUR" } });
    const r = allocateCostSet([eurAuction], products([1, 1]));
    expect(r.intakes[0]).toMatchObject({ officialEurCents: 119800, fxDiffCents: 0 });
    expect(r.items.map((i) => i.totalCents)).toEqual([59900, 59900]);
  });

  it("blocks with a list of issues: missing weight, rate, bank debit, no auction, other type, not reviewed, no products", () => {
    const codes = (r: ReturnType<typeof allocateCostSet>) => r.issues.map((i) => i.code).sort();
    expect(codes(allocateCostSet([auction()], products([10, null])))).toEqual(["MISSING_WEIGHT"]);
    expect(codes(allocateCostSet([auction()], products([10, 0])))).toEqual(["MISSING_WEIGHT"]);
    expect(codes(allocateCostSet([intake({ fxRate: null })], products()))).toEqual(["MISSING_RATE"]);
    expect(codes(allocateCostSet([intake({ bankDebitEur: null })], products()))).toEqual(["MISSING_BANK_DEBIT"]);
    expect(codes(allocateCostSet([transport()], products()))).toEqual(["NO_AUCTION_INVOICE"]);
    expect(codes(allocateCostSet([auction(), intake({ id: "o", invoiceType: "other" })], products()))).toContain("UNSUPPORTED_INVOICE_TYPE");
    expect(codes(allocateCostSet([auction(), intake({ id: "x", invoiceType: "transport", status: "extracted", values: null })], products()))).toEqual(["INTAKE_NOT_REVIEWED"]);
    expect(codes(allocateCostSet([auction(), intake({ id: "c", invoiceType: "other", status: "cancelled" })], products()))).toEqual([]);
    expect(codes(allocateCostSet([auction()], []))).toContain("NO_PRODUCTS");
    expect(allocateCostSet([auction()], products([10, null])).items).toEqual([]);
  });

  it("blocks an item whose total would not be above 0", () => {
    const r = allocateCostSet([intake({ bankDebitEur: 0.01 })], products([1000, 1]));
    expect(r.issues.map((i) => i.code)).toEqual(["NON_POSITIVE_ITEM_TOTAL"]);
  });

  it("warns (non-blocking) on an existing purchase cost, several lots and an item-count mismatch", () => {
    const items = products([10, 20]);
    items[0].purchaseCost = 12.5;
    const second = intake({ id: "a2", invoiceNumber: "227553", values: { ...auctionValues(), lots: [{ lotNumber: "5332165", title: "x", itemCountHint: null, amount: 945 }] } });
    const r = allocateCostSet([auction(), second], items);
    expect(r.issues).toEqual([]);
    expect(r.warnings.map((w) => w.code).sort()).toEqual(["ITEM_COUNT_MISMATCH", "MULTIPLE_LOTS", "PURCHASE_COST_ALREADY_SET"]);
    expect(r.lotNumbers).toEqual(["5332164", "5332165"]);
  });
});
