/**
 * Sprint 79: single source of truth for invoice VAT/rounding math, shared between
 * apps/api (authoritative — the only place a calculation is ever persisted) and
 * apps/admin (allowed to import this for a live preview only; the persisted result
 * always comes back from the API).
 *
 * Rounding convention: every intermediate monetary value (taxable base, VAT amount,
 * line/shipping total, discount allocation) is rounded to the nearest cent immediately
 * after it is computed, using round-half-away-from-zero via Number.toFixed(2). Nothing
 * is kept at sub-cent precision between steps.
 */

export function roundMoney(n: number): number {
  return Number((Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2));
}

/** Thrown by calculateInvoiceTotals for input that is not merely a rounding edge case but a genuine contract violation (e.g. a discount larger than the amount it is being deducted from). apps/api's callers map this to a 400 BadRequestError. */
export class InvoiceCalculationError extends Error {}

export interface InvoiceCalculationLineInput {
  quantity: number;
  unitPrice: number;
  discountAmount: number;
  vatRate: number;
  /** ManualOverride only: when set, this VAT amount is used verbatim instead of being derived from vatRate. */
  manualVatAmount?: number | null;
}

export interface InvoiceCalculationLineResult {
  quantity: number;
  unitPrice: number;
  discountAmount: number;
  vatRate: number;
  taxableBase: number;
  vatAmount: number;
  lineTotal: number;
  /** Sprint 79 correction: this line's share of the invoice-level discount (see calculateInvoiceTotals doc comment). Always 0 when discountAmount is 0. */
  allocatedInvoiceDiscount: number;
}

export interface InvoiceCalculationInput {
  lines: InvoiceCalculationLineInput[];
  /** Invoice-level extra discount — allocated proportionally across eligible lines' taxable bases before VAT is computed (Sprint 79 correction; see calculateInvoiceTotals doc comment). Never applied to shipping. */
  discountAmount: number;
  shippingAmount: number;
  shippingVatRate: number;
  /** ManualOverride only: when set, this VAT amount is used verbatim for shipping. */
  manualShippingVatAmount?: number | null;
  /**
   * Whether unitPrice/shippingAmount are entered VAT-inclusive (gross) or
   * VAT-exclusive (net). Governs the whole invoice, not per line.
   */
  pricesIncludeVat: boolean;
}

export interface InvoiceCalculationResult {
  lines: InvoiceCalculationLineResult[];
  subtotal: number;
  discountAmount: number;
  shippingAmount: number;
  shippingVatAmount: number;
  taxVatAmount: number;
  totalAmount: number;
}

/**
 * Sprint 79 correction: invoice-level discount is now allocated proportionally across each
 * eligible line's *pre-invoice-discount* taxable base (i.e. after that line's own
 * discountAmount is already applied, but before the invoice-level one) — matching the required
 * order "line-level discounts continue to apply before invoice-level discount allocation".
 * VAT is then computed from each line's *post-allocation* taxable base, so the invoice discount
 * genuinely reduces the VAT owed, proportionally, rather than being a flat, un-taxed rebate
 * applied only to the grand total (the previous, Sprint-79-original behavior).
 *
 * Rounding: each line's share is `round(discount * lineBase / eligibleBase)`, except the last
 * eligible (taxableBase > 0) line, which instead receives `discount - sum(shares already
 * allocated)` — guaranteeing the allocated total exactly equals the input discount, with the
 * same "remainder goes to the last line" convention already used by
 * apps/api/src/services/erpPurchasingBridge.ts's landed-cost split() helper. A line with a
 * zero (or already-fully-discounted) taxable base receives no share and is not "the last line"
 * for this purpose. Shipping is never included in this allocation — a separate, un-discounted
 * shipping VAT calculation runs exactly as before.
 *
 * Required invariant (verified by tests): subtotal - discountAmount + taxVatAmount +
 * shippingAmount === totalAmount. `subtotal` is the sum of each line's *pre-invoice-discount*
 * taxable base (so it is unaffected by how the discount is allocated); `discountAmount` is the
 * invoice-level discount as given (which by construction equals the sum of all lines'
 * allocatedInvoiceDiscount); each returned line's own `taxableBase`/`vatAmount`/`lineTotal`
 * reflect the *post-allocation* (actually-charged) figures.
 */
export function calculateInvoiceTotals(input: InvoiceCalculationInput): InvoiceCalculationResult {
  const pricesIncludeVat = input.pricesIncludeVat;
  const pre = input.lines.map((l) => {
    const rate = Number(l.vatRate) || 0;
    const grossAfterLineDiscount = roundMoney(l.quantity * l.unitPrice - l.discountAmount);
    const taxableBasePre = pricesIncludeVat ? roundMoney(grossAfterLineDiscount / (1 + rate / 100)) : grossAfterLineDiscount;
    return { input: l, rate, grossAfterLineDiscount, taxableBasePre };
  });

  const eligibleBase = roundMoney(pre.reduce((a, p) => a + Math.max(0, p.taxableBasePre), 0));
  const invoiceDiscount = roundMoney(input.discountAmount);
  if (invoiceDiscount < 0) throw new InvoiceCalculationError("Invoice discount cannot be negative");
  if (invoiceDiscount > eligibleBase) throw new InvoiceCalculationError("Invoice discount cannot exceed the eligible line taxable base");

  const eligibleIdx = pre.map((_, i) => i).filter((i) => pre[i].taxableBasePre > 0);
  const allocations = pre.map(() => 0);
  let used = 0;
  eligibleIdx.forEach((idx, pos) => {
    const isLast = pos === eligibleIdx.length - 1;
    const share = isLast || eligibleBase === 0 ? roundMoney(invoiceDiscount - used) : roundMoney((invoiceDiscount * pre[idx].taxableBasePre) / eligibleBase);
    allocations[idx] = share;
    used = roundMoney(used + share);
  });

  const lines: InvoiceCalculationLineResult[] = pre.map((p, i) => {
    const allocated = allocations[i];
    const manual = p.input.manualVatAmount;
    // taxableBasePre is already the net (taxable) figure for both pricing modes (derived earlier
    // from the entered price according to pricesIncludeVat). subtotal/eligibleBase and the
    // invoice-level invariant (subtotal - discountAmount + taxVatAmount + shippingAmount ===
    // totalAmount) are expressed in that same net scale, so the discount must be subtracted from
    // the net base here too — subtracting it from the gross (pre-VAT-inclusive) figure instead
    // would apply the discount at the wrong scale and silently break the invariant.
    const taxableBase = roundMoney(p.taxableBasePre - allocated);
    const vatAmount = manual != null ? roundMoney(manual) : roundMoney(taxableBase * (p.rate / 100));
    const lineTotal = roundMoney(taxableBase + vatAmount);
    return { quantity: p.input.quantity, unitPrice: p.input.unitPrice, discountAmount: p.input.discountAmount, vatRate: p.rate, taxableBase, vatAmount, lineTotal, allocatedInvoiceDiscount: allocated };
  });

  const subtotal = eligibleBase;
  const shippingRate = Number(input.shippingVatRate) || 0;
  const shippingGrossOrNet = roundMoney(input.shippingAmount);
  let shippingAmount: number;
  let shippingVatAmount: number;
  if (input.manualShippingVatAmount != null) {
    shippingVatAmount = roundMoney(input.manualShippingVatAmount);
    shippingAmount = pricesIncludeVat ? roundMoney(shippingGrossOrNet - shippingVatAmount) : shippingGrossOrNet;
  } else if (pricesIncludeVat) {
    shippingAmount = roundMoney(shippingGrossOrNet / (1 + shippingRate / 100));
    shippingVatAmount = roundMoney(shippingGrossOrNet - shippingAmount);
  } else {
    shippingAmount = shippingGrossOrNet;
    shippingVatAmount = roundMoney(shippingAmount * (shippingRate / 100));
  }
  const taxVatAmount = roundMoney(lines.reduce((a, l) => a + l.vatAmount, 0) + shippingVatAmount);
  const totalAmount = roundMoney(subtotal - invoiceDiscount + taxVatAmount + shippingAmount);
  return { lines, subtotal, discountAmount: invoiceDiscount, shippingAmount, shippingVatAmount, taxVatAmount, totalAmount };
}
