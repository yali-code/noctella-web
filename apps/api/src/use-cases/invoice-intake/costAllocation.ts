import { toCents, type InvoiceValues } from "./invoiceReview";

/**
 * PHASE-2C: pure cost-set allocation (owner decisions D3-D7). All money is integer euro-cents.
 * - Per invoice: officialTotal = round(total / fxRate x 100) (ECB, 1 EUR = rate CUR), split over the invoice's
 *   components in proportion to their original amounts; fxDiff = bankDebit - officialTotal (may be negative).
 * - Over the selected items: lot, hammer, premium and the auction fxDiff by value weight; transport, forwarder
 *   and their fxDiff equally. Every split is largest-remainder (ties to the lower index), so every component sums
 *   exactly and the item totals sum exactly to the bank debits.
 * Violations are returned as blocking issues, never thrown.
 */
export interface AllocationIntakeInput {
  id: string;
  status: string;
  invoiceType: string;
  invoiceNumber: string | null;
  currency: string | null;
  fxRate: number | null;
  fxRateDate: string | null;
  fxSource: string | null;
  bankDebitEur: number | null;
  values: InvoiceValues | null;
}

export interface AllocationItemInput {
  productId: string;
  sku: string | null;
  title: string | null;
  valueWeightEur: number | null;
  weightSource: string | null;
  purchaseCost: number | null;
}

export interface CostSetIssue { code: string; message: string; intakeId?: string; productId?: string }

export interface IntakeAllocation {
  intakeId: string;
  invoiceType: string;
  invoiceNumber: string | null;
  currency: string | null;
  totalOriginal: number | null;
  fxRate: number | null;
  fxRateDate: string | null;
  fxSource: string | null;
  officialEurCents: number;
  bankDebitCents: number;
  fxDiffCents: number;
  componentsCents: { lot: number; hammer: number; premium: number; transport: number; forwarder: number };
}

export interface ItemAllocation {
  productId: string;
  sku: string | null;
  title: string | null;
  lotCents: number;
  hammerFeeCents: number;
  premiumCents: number;
  transportCents: number;
  forwarderCents: number;
  fxDiffCents: number;
  totalCents: number;
}

export interface CostSetAllocation {
  issues: CostSetIssue[];
  warnings: CostSetIssue[];
  intakes: IntakeAllocation[];
  items: ItemAllocation[];
  totalBankDebitCents: number;
  totalAllocatedCents: number;
  lotNumbers: string[];
}

export const ALLOCATABLE_INVOICE_TYPES = ["auction", "transport", "forwarder"] as const;

/**
 * Largest-remainder split of an integer total over non-negative integer weights. Exact (BigInt), deterministic:
 * leftover cents go to the largest remainders, ties to the lower index. A negative total is split by magnitude.
 */
export function largestRemainderSplit(totalCents: number, weights: number[]): number[] {
  if (!Number.isInteger(totalCents)) throw new Error("largestRemainderSplit: total must be integer cents");
  if (weights.length === 0) throw new Error("largestRemainderSplit: no weights");
  if (weights.some((w) => !Number.isInteger(w) || w < 0)) throw new Error("largestRemainderSplit: weights must be non-negative integers");
  const sum = weights.reduce((a, b) => a + BigInt(b), 0n);
  if (sum === 0n) throw new Error("largestRemainderSplit: weights sum to zero");
  const sign = totalCents < 0 ? -1 : 1;
  const total = BigInt(Math.abs(totalCents));
  const parts = weights.map((w, index) => ({ index, floor: (total * BigInt(w)) / sum, rem: (total * BigInt(w)) % sum }));
  let left = total - parts.reduce((a, p) => a + p.floor, 0n);
  const order = [...parts].sort((a, b) => (a.rem === b.rem ? a.index - b.index : a.rem > b.rem ? -1 : 1));
  for (const p of order) {
    if (left === 0n) break;
    p.floor += 1n;
    left -= 1n;
  }
  return parts.map((p) => sign * Number(p.floor));
}

/** Original-currency components (cents) of one invoice by its type. Auction fees other than hammer/premium join the lot component. */
export function invoiceComponents(type: string, values: InvoiceValues) {
  const out = { lot: 0, hammer: 0, premium: 0, transport: 0, forwarder: 0 };
  if (type === "auction") {
    for (const l of values.lots) out.lot += toCents(l.amount ?? 0);
    for (const f of values.fees) {
      const c = toCents(f.amount ?? 0);
      if (f.type === "hammer_fee") out.hammer += c;
      else if (f.type === "buyer_premium") out.premium += c;
      else out.lot += c;
    }
  } else if (type === "transport") {
    out.transport = toCents(values.total ?? 0);
  } else if (type === "forwarder") {
    out.forwarder = toCents(values.total ?? 0);
  }
  return out;
}

/** Official EUR of an original-currency amount at an ECB rate (1 EUR = rate CUR), in cents. */
export const officialEurCents = (totalOriginal: number, fxRate: number) => Math.round((totalOriginal / fxRate) * 100);

const COMPONENT_KEYS = ["lot", "hammer", "premium", "transport", "forwarder"] as const;
const weightCents = (eur: number) => Math.round(eur * 100);

export function allocateCostSet(intakes: AllocationIntakeInput[], items: AllocationItemInput[]): CostSetAllocation {
  const issues: CostSetIssue[] = [];
  const warnings: CostSetIssue[] = [];
  const active = intakes.filter((i) => i.status !== "cancelled");

  if (items.length === 0) issues.push({ code: "NO_PRODUCTS", message: "Select at least one product" });
  if (!active.some((i) => i.invoiceType === "auction")) issues.push({ code: "NO_AUCTION_INVOICE", message: "The set needs at least one auction invoice" });
  for (const i of active) {
    const label = `Invoice ${i.invoiceNumber ?? i.id}`;
    if (!(ALLOCATABLE_INVOICE_TYPES as readonly string[]).includes(i.invoiceType)) issues.push({ code: "UNSUPPORTED_INVOICE_TYPE", intakeId: i.id, message: `${label}: type "${i.invoiceType}" cannot be allocated; change its type or cancel it` });
    if (i.status !== "reviewed" || !i.values) { issues.push({ code: "INTAKE_NOT_REVIEWED", intakeId: i.id, message: `${label} is not reviewed` }); continue; }
    if (i.values.total == null || i.values.total <= 0) issues.push({ code: "MISSING_TOTAL", intakeId: i.id, message: `${label} has no positive total` });
    if (!(i.fxRate != null && i.fxRate > 0)) issues.push({ code: "MISSING_RATE", intakeId: i.id, message: `${label} has no official exchange rate` });
    if (!(i.bankDebitEur != null && i.bankDebitEur > 0)) issues.push({ code: "MISSING_BANK_DEBIT", intakeId: i.id, message: `${label} has no bank debit` });
    const components = invoiceComponents(i.invoiceType, i.values);
    if (COMPONENT_KEYS.some((k) => components[k] < 0)) issues.push({ code: "NEGATIVE_COMPONENT", intakeId: i.id, message: `${label} has a negative lot or fee amount` });
    else if ((ALLOCATABLE_INVOICE_TYPES as readonly string[]).includes(i.invoiceType) && !COMPONENT_KEYS.some((k) => components[k] > 0)) issues.push({ code: "NO_COMPONENTS", intakeId: i.id, message: `${label} has no lot or fee amounts to allocate` });
  }
  for (const item of items) {
    if (!(item.valueWeightEur != null && weightCents(item.valueWeightEur) > 0)) issues.push({ code: "MISSING_WEIGHT", productId: item.productId, message: `${item.sku ?? item.productId}: value weight is missing or not above 0` });
    if (item.purchaseCost != null) warnings.push({ code: "PURCHASE_COST_ALREADY_SET", productId: item.productId, message: `${item.sku ?? item.productId} already has a purchase cost; it will not be overwritten and profitability will show a cost basis conflict` });
  }

  const lotNumbers = [...new Set(active.filter((i) => i.invoiceType === "auction" && i.values).flatMap((i) => i.values!.lots.map((l) => l.lotNumber?.trim()).filter((n): n is string => !!n)))];
  if (lotNumbers.length > 1) warnings.push({ code: "MULTIPLE_LOTS", message: `The set has ${lotNumbers.length} auction lots (${lotNumbers.join(", ")}); one set per lot is recommended` });
  for (const i of active) {
    if (i.invoiceType !== "auction" || !i.values) continue;
    for (const lot of i.values.lots) if (lot.itemCountHint != null && lot.itemCountHint !== items.length) warnings.push({ code: "ITEM_COUNT_MISMATCH", intakeId: i.id, message: `Lot ${lot.lotNumber ?? "?"} says ${lot.itemCountHint} item(s), ${items.length} product(s) selected` });
  }

  const empty: CostSetAllocation = { issues, warnings, intakes: [], items: [], totalBankDebitCents: 0, totalAllocatedCents: 0, lotNumbers };
  if (issues.length) return empty;

  // Per invoice: official EUR split over its components, and the FX difference to the bank debit.
  const perIntake: IntakeAllocation[] = active.map((i) => {
    const values = i.values!;
    const original = invoiceComponents(i.invoiceType, values);
    const official = officialEurCents(values.total!, i.fxRate!);
    const keys = COMPONENT_KEYS.filter((k) => original[k] > 0);
    if (!keys.length) throw new Error("A reviewed invoice with a positive total has no positive component");
    const split = largestRemainderSplit(official, keys.map((k) => original[k]));
    const componentsCents = { lot: 0, hammer: 0, premium: 0, transport: 0, forwarder: 0 };
    keys.forEach((k, idx) => { componentsCents[k] = split[idx]; });
    const bankDebitCents = toCents(i.bankDebitEur!);
    return {
      intakeId: i.id, invoiceType: i.invoiceType, invoiceNumber: i.invoiceNumber, currency: i.currency, totalOriginal: values.total,
      fxRate: i.fxRate, fxRateDate: i.fxRateDate, fxSource: i.fxSource, officialEurCents: official, bankDebitCents, fxDiffCents: bankDebitCents - official, componentsCents,
    };
  });

  const sumOf = (pick: (a: IntakeAllocation) => number, types: string[]) => perIntake.filter((a) => types.includes(a.invoiceType)).reduce((acc, a) => acc + pick(a), 0);
  const weights = items.map((it) => weightCents(it.valueWeightEur!));
  const equal = items.map(() => 1);
  const lot = largestRemainderSplit(sumOf((a) => a.componentsCents.lot, ["auction"]), weights);
  const hammer = largestRemainderSplit(sumOf((a) => a.componentsCents.hammer, ["auction"]), weights);
  const premium = largestRemainderSplit(sumOf((a) => a.componentsCents.premium, ["auction"]), weights);
  const auctionFx = largestRemainderSplit(sumOf((a) => a.fxDiffCents, ["auction"]), weights);
  const transport = largestRemainderSplit(sumOf((a) => a.componentsCents.transport, ["transport"]), equal);
  const transportFx = largestRemainderSplit(sumOf((a) => a.fxDiffCents, ["transport"]), equal);
  const forwarder = largestRemainderSplit(sumOf((a) => a.componentsCents.forwarder, ["forwarder"]), equal);
  const forwarderFx = largestRemainderSplit(sumOf((a) => a.fxDiffCents, ["forwarder"]), equal);

  const allocated: ItemAllocation[] = items.map((it, k) => {
    const fxDiffCents = auctionFx[k] + transportFx[k] + forwarderFx[k];
    const totalCents = lot[k] + hammer[k] + premium[k] + transport[k] + forwarder[k] + fxDiffCents;
    return { productId: it.productId, sku: it.sku, title: it.title, lotCents: lot[k], hammerFeeCents: hammer[k], premiumCents: premium[k], transportCents: transport[k], forwarderCents: forwarder[k], fxDiffCents, totalCents };
  });

  const totalBankDebitCents = perIntake.reduce((a, i) => a + i.bankDebitCents, 0);
  const totalAllocatedCents = allocated.reduce((a, i) => a + i.totalCents, 0);
  // Invariant: the split is exact by construction; a mismatch is a programming error, not an input problem.
  if (totalAllocatedCents !== totalBankDebitCents) throw new Error("Cost set allocation does not sum to the bank debits");
  for (const it of allocated) if (it.totalCents <= 0) issues.push({ code: "NON_POSITIVE_ITEM_TOTAL", productId: it.productId, message: `${it.sku ?? it.productId} would get a total cost of ${(it.totalCents / 100).toFixed(2)} EUR; adjust the weights` });

  return { issues, warnings, intakes: perIntake, items: allocated, totalBankDebitCents, totalAllocatedCents, lotNumbers };
}
