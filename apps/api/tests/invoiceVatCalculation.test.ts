import { describe, expect, it } from "vitest";
import { calculateInvoiceTotals, roundMoney } from "@noctella/shared";

describe("Sprint 79 invoice VAT/rounding calculation service (single source of truth, apps/api and apps/admin preview both import this)", () => {
  it("VAT-exclusive: taxable base = entered amount, VAT = base * rate/100, gross = base + VAT", () => {
    const result = calculateInvoiceTotals({ lines: [{ quantity: 2, unitPrice: 50, discountAmount: 0, vatRate: 20 }], discountAmount: 0, shippingAmount: 0, shippingVatRate: 0, pricesIncludeVat: false });
    expect(result.lines[0].taxableBase).toBe(100);
    expect(result.lines[0].vatAmount).toBe(20);
    expect(result.lines[0].lineTotal).toBe(120);
    expect(result.subtotal).toBe(100);
    expect(result.taxVatAmount).toBe(20);
    expect(result.totalAmount).toBe(120);
  });

  it("VAT-inclusive: gross = entered amount, taxable base = gross / (1 + rate/100), VAT = gross - base", () => {
    const result = calculateInvoiceTotals({ lines: [{ quantity: 1, unitPrice: 120, discountAmount: 0, vatRate: 20 }], discountAmount: 0, shippingAmount: 0, shippingVatRate: 0, pricesIncludeVat: true });
    expect(result.lines[0].lineTotal).toBe(120);
    expect(result.lines[0].taxableBase).toBe(100);
    expect(result.lines[0].vatAmount).toBe(20);
    expect(result.totalAmount).toBe(120);
  });

  it("0% VAT: taxable base equals gross in both modes, VAT is exactly zero", () => {
    const exclusive = calculateInvoiceTotals({ lines: [{ quantity: 1, unitPrice: 100, discountAmount: 0, vatRate: 0 }], discountAmount: 0, shippingAmount: 0, shippingVatRate: 0, pricesIncludeVat: false });
    expect(exclusive.lines[0].vatAmount).toBe(0);
    expect(exclusive.lines[0].lineTotal).toBe(100);
    const inclusive = calculateInvoiceTotals({ lines: [{ quantity: 1, unitPrice: 100, discountAmount: 0, vatRate: 0 }], discountAmount: 0, shippingAmount: 0, shippingVatRate: 0, pricesIncludeVat: true });
    expect(inclusive.lines[0].vatAmount).toBe(0);
    expect(inclusive.lines[0].taxableBase).toBe(100);
  });

  it("accepts a decimal VAT rate (e.g. 5.5%) and computes correctly", () => {
    const result = calculateInvoiceTotals({ lines: [{ quantity: 1, unitPrice: 200, discountAmount: 0, vatRate: 5.5 }], discountAmount: 0, shippingAmount: 0, shippingVatRate: 0, pricesIncludeVat: false });
    expect(result.lines[0].vatAmount).toBe(11);
    expect(result.lines[0].lineTotal).toBe(211);
  });

  it("line discount reduces the taxable base before VAT is applied", () => {
    const result = calculateInvoiceTotals({ lines: [{ quantity: 1, unitPrice: 100, discountAmount: 10, vatRate: 20 }], discountAmount: 0, shippingAmount: 0, shippingVatRate: 0, pricesIncludeVat: false });
    expect(result.lines[0].taxableBase).toBe(90);
    expect(result.lines[0].vatAmount).toBe(18);
    expect(result.lines[0].lineTotal).toBe(108);
  });

  it("Sprint 79 correction: invoice-level discount is allocated proportionally to the line's taxable base and DOES reduce the VAT owed", () => {
    const result = calculateInvoiceTotals({ lines: [{ quantity: 1, unitPrice: 100, discountAmount: 0, vatRate: 20 }], discountAmount: 10, shippingAmount: 0, shippingVatRate: 0, pricesIncludeVat: false });
    expect(result.subtotal).toBe(100);
    expect(result.discountAmount).toBe(10);
    expect(result.lines[0].allocatedInvoiceDiscount).toBe(10);
    expect(result.lines[0].taxableBase).toBe(90);
    expect(result.lines[0].vatAmount).toBe(18);
    expect(result.taxVatAmount).toBe(18);
    expect(result.totalAmount).toBe(108); // 100 - 10 + 18 + 0
  });

  it("shipping VAT is computed independently of line VAT, same exclusive/inclusive rule", () => {
    const exclusive = calculateInvoiceTotals({ lines: [{ quantity: 1, unitPrice: 100, discountAmount: 0, vatRate: 0 }], discountAmount: 0, shippingAmount: 10, shippingVatRate: 20, pricesIncludeVat: false });
    expect(exclusive.shippingAmount).toBe(10);
    expect(exclusive.shippingVatAmount).toBe(2);
    expect(exclusive.totalAmount).toBe(112);

    const inclusive = calculateInvoiceTotals({ lines: [{ quantity: 1, unitPrice: 100, discountAmount: 0, vatRate: 0 }], discountAmount: 0, shippingAmount: 12, shippingVatRate: 20, pricesIncludeVat: true });
    expect(inclusive.shippingAmount).toBe(10);
    expect(inclusive.shippingVatAmount).toBe(2);
    expect(inclusive.totalAmount).toBe(112);
  });

  it("manual VAT amount override (line and shipping) is used verbatim instead of being derived from the rate", () => {
    const result = calculateInvoiceTotals({
      lines: [{ quantity: 1, unitPrice: 100, discountAmount: 0, vatRate: 20, manualVatAmount: 5 }],
      discountAmount: 0, shippingAmount: 10, shippingVatRate: 20, manualShippingVatAmount: 1,
      pricesIncludeVat: false,
    });
    expect(result.lines[0].vatAmount).toBe(5);
    expect(result.lines[0].lineTotal).toBe(105);
    expect(result.shippingVatAmount).toBe(1);
    expect(result.taxVatAmount).toBe(6);
  });

  it("rounds every intermediate monetary value to the nearest cent (rounding-edge case)", () => {
    expect(roundMoney(10.005)).toBe(10.01);
    expect(roundMoney(10.004)).toBe(10);
    const result = calculateInvoiceTotals({ lines: [{ quantity: 3, unitPrice: 10.005, discountAmount: 0, vatRate: 21 }], discountAmount: 0, shippingAmount: 0, shippingVatRate: 0, pricesIncludeVat: false });
    // 3 * 10.005 = 30.015 -> rounds to 30.02 before VAT is applied.
    expect(result.lines[0].taxableBase).toBe(30.02);
  });

  it("required invariant holds across a mixed multi-line, discounted, shipped, VAT-inclusive invoice: subtotal - discountAmount + taxVatAmount + shippingAmount === totalAmount", () => {
    const cases: any[] = [
      { lines: [{ quantity: 2, unitPrice: 49.99, discountAmount: 3.5, vatRate: 21 }, { quantity: 1, unitPrice: 15, discountAmount: 0, vatRate: 9 }], discountAmount: 2, shippingAmount: 7.5, shippingVatRate: 21, pricesIncludeVat: false },
      { lines: [{ quantity: 1, unitPrice: 121, discountAmount: 0, vatRate: 21 }, { quantity: 4, unitPrice: 6.05, discountAmount: 1, vatRate: 5.5 }], discountAmount: 1.25, shippingAmount: 12, shippingVatRate: 21, pricesIncludeVat: true },
    ];
    for (const input of cases) {
      const result = calculateInvoiceTotals(input);
      expect(roundMoney(result.subtotal - result.discountAmount + result.taxVatAmount + result.shippingAmount)).toBe(result.totalAmount);
    }
  });

  it("never produces a negative total from non-negative inputs and rejects nothing that is a valid 0-100 rate", () => {
    for (const rate of [0, 5.5, 9, 20, 21, 100]) {
      const result = calculateInvoiceTotals({ lines: [{ quantity: 1, unitPrice: 10, discountAmount: 0, vatRate: rate }], discountAmount: 0, shippingAmount: 0, shippingVatRate: 0, pricesIncludeVat: false });
      expect(result.totalAmount).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(result.totalAmount)).toBe(false);
    }
  });
});

describe("Sprint 79 correction: proportional invoice-discount VAT allocation", () => {
  it("one line at 20%: full discount allocated to the single line, VAT reduced proportionally", () => {
    const r = calculateInvoiceTotals({ lines: [{ quantity: 1, unitPrice: 100, discountAmount: 0, vatRate: 20 }], discountAmount: 20, shippingAmount: 0, shippingVatRate: 0, pricesIncludeVat: false });
    expect(r.lines[0].allocatedInvoiceDiscount).toBe(20);
    expect(r.lines[0].taxableBase).toBe(80);
    expect(r.lines[0].vatAmount).toBe(16);
    expect(r.totalAmount).toBe(96); // 100 - 20 + 16 + 0
  });

  it("two equal lines at 20%: discount split evenly, VAT reduced on both", () => {
    const r = calculateInvoiceTotals({ lines: [{ quantity: 1, unitPrice: 100, discountAmount: 0, vatRate: 20 }, { quantity: 1, unitPrice: 100, discountAmount: 0, vatRate: 20 }], discountAmount: 20, shippingAmount: 0, shippingVatRate: 0, pricesIncludeVat: false });
    expect(r.lines[0].allocatedInvoiceDiscount).toBe(10);
    expect(r.lines[1].allocatedInvoiceDiscount).toBe(10);
    expect(r.lines[0].taxableBase).toBe(90);
    expect(r.lines[1].taxableBase).toBe(90);
    expect(r.taxVatAmount).toBe(36); // (90*0.20)*2
    expect(r.totalAmount).toBe(216); // 200 - 20 + 36 + 0
  });

  it("mixed 20% and 9% lines: discount allocated by weight, each line's own rate applied to its post-allocation base", () => {
    // weights: 100/(100+50)=2/3, 50/150=1/3 of a 30 discount -> 20 and 10
    const r = calculateInvoiceTotals({ lines: [{ quantity: 1, unitPrice: 100, discountAmount: 0, vatRate: 20 }, { quantity: 1, unitPrice: 50, discountAmount: 0, vatRate: 9 }], discountAmount: 30, shippingAmount: 0, shippingVatRate: 0, pricesIncludeVat: false });
    expect(r.lines[0].allocatedInvoiceDiscount).toBe(20);
    expect(r.lines[1].allocatedInvoiceDiscount).toBe(10);
    expect(r.lines[0].taxableBase).toBe(80);
    expect(r.lines[1].taxableBase).toBe(40);
    expect(r.lines[0].vatAmount).toBe(16); // 80*0.20
    expect(r.lines[1].vatAmount).toBe(3.6); // 40*0.09
    expect(roundMoney(r.subtotal - r.discountAmount + r.taxVatAmount + r.shippingAmount)).toBe(r.totalAmount);
  });

  it("VAT-inclusive prices: discount is allocated against the pre-discount taxable base (net scale), not the gross", () => {
    // gross=120 at 20% => taxableBasePre=100 (net); a 10 discount is allocated against that net
    // base (same scale as subtotal/eligibleBase) => taxableBase=100-10=90, vat=90*0.20=18,
    // lineTotal=90+18=108. Subtracting the discount from the gross figure instead (120-10=110,
    // then re-deriving) would apply it at the wrong scale and break the documented invariant.
    const r = calculateInvoiceTotals({ lines: [{ quantity: 1, unitPrice: 120, discountAmount: 0, vatRate: 20 }], discountAmount: 10, shippingAmount: 0, shippingVatRate: 0, pricesIncludeVat: true });
    expect(r.lines[0].allocatedInvoiceDiscount).toBe(10);
    expect(r.lines[0].taxableBase).toBe(90);
    expect(r.lines[0].vatAmount).toBe(18);
    expect(r.lines[0].lineTotal).toBe(108);
    expect(roundMoney(r.lines[0].taxableBase + r.lines[0].vatAmount)).toBe(r.lines[0].lineTotal);
    expect(roundMoney(r.subtotal - r.discountAmount + r.taxVatAmount + r.shippingAmount)).toBe(r.totalAmount);
    expect(r.totalAmount).toBe(108);
  });

  it("VAT-exclusive prices: discount reduces the taxable base directly before VAT is computed", () => {
    const r = calculateInvoiceTotals({ lines: [{ quantity: 1, unitPrice: 100, discountAmount: 0, vatRate: 20 }], discountAmount: 25, shippingAmount: 0, shippingVatRate: 0, pricesIncludeVat: false });
    expect(r.lines[0].taxableBase).toBe(75);
    expect(r.lines[0].vatAmount).toBe(15);
  });

  it("line discount plus invoice discount: line discount applies first, invoice discount allocates against the already-reduced base", () => {
    // line: 100 - 10 (line discount) = 90 taxable base pre-invoice-discount; a 9 invoice discount (10% of the pre base) reduces it to 81
    const r = calculateInvoiceTotals({ lines: [{ quantity: 1, unitPrice: 100, discountAmount: 10, vatRate: 20 }], discountAmount: 9, shippingAmount: 0, shippingVatRate: 0, pricesIncludeVat: false });
    expect(r.lines[0].allocatedInvoiceDiscount).toBe(9);
    expect(r.lines[0].taxableBase).toBe(81);
    expect(r.lines[0].vatAmount).toBe(16.2);
  });

  it("cent-rounding remainder is absorbed entirely by the last eligible line, so allocated shares always sum exactly to the invoice discount", () => {
    // three equal lines, discount of 10 does not divide evenly by 3
    const r = calculateInvoiceTotals({ lines: [{ quantity: 1, unitPrice: 100, discountAmount: 0, vatRate: 0 }, { quantity: 1, unitPrice: 100, discountAmount: 0, vatRate: 0 }, { quantity: 1, unitPrice: 100, discountAmount: 0, vatRate: 0 }], discountAmount: 10, shippingAmount: 0, shippingVatRate: 0, pricesIncludeVat: false });
    const sumAllocated = roundMoney(r.lines.reduce((a, l) => a + l.allocatedInvoiceDiscount, 0));
    expect(sumAllocated).toBe(10);
    expect(r.lines[0].allocatedInvoiceDiscount).toBe(3.33);
    expect(r.lines[1].allocatedInvoiceDiscount).toBe(3.33);
    expect(r.lines[2].allocatedInvoiceDiscount).toBe(3.34); // remainder absorbed by the last eligible line
  });

  it("invoice discount equal to the full eligible base is accepted and zeroes out the taxable base", () => {
    const r = calculateInvoiceTotals({ lines: [{ quantity: 1, unitPrice: 100, discountAmount: 0, vatRate: 20 }], discountAmount: 100, shippingAmount: 0, shippingVatRate: 0, pricesIncludeVat: false });
    expect(r.lines[0].taxableBase).toBe(0);
    expect(r.lines[0].vatAmount).toBe(0);
    expect(r.totalAmount).toBe(0);
  });

  it("invoice discount greater than the eligible base is rejected with InvoiceCalculationError", async () => {
    const { InvoiceCalculationError } = await import("@noctella/shared");
    expect(() => calculateInvoiceTotals({ lines: [{ quantity: 1, unitPrice: 100, discountAmount: 0, vatRate: 20 }], discountAmount: 100.01, shippingAmount: 0, shippingVatRate: 0, pricesIncludeVat: false })).toThrow(InvoiceCalculationError);
  });

  it("shipping is never touched by the product-line invoice discount", () => {
    const r = calculateInvoiceTotals({ lines: [{ quantity: 1, unitPrice: 100, discountAmount: 0, vatRate: 20 }], discountAmount: 20, shippingAmount: 10, shippingVatRate: 20, pricesIncludeVat: false });
    expect(r.shippingAmount).toBe(10);
    expect(r.shippingVatAmount).toBe(2);
  });
});
