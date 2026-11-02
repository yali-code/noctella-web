import {
  INVOICE_FEE_FIELD_NAMES,
  INVOICE_HEADER_FIELD_NAMES,
  INVOICE_LOT_FIELD_NAMES,
  type EXTRACTION_FEE_TYPES,
  type InvoiceExtraction,
} from "../../ai-intake/invoiceExtractionSchema";

/**
 * PHASE-2B: business rules for reviewing an AI-read invoice. Effective values = the extraction's values,
 * overridden by the admin's edits (a key present in edits wins, even when null; lots/fees are replaced whole).
 * The checks are computed here in code - never by the model - in integer cents.
 */
export interface InvoiceLotValues { lotNumber: string | null; title: string | null; itemCountHint: number | null; amount: number | null }
export interface InvoiceFeeValues { type: (typeof EXTRACTION_FEE_TYPES)[number] | null; label: string | null; amount: number | null; percent: number | null; lotNumber: string | null }
export interface InvoiceValues {
  invoiceType: "auction" | "transport" | "forwarder" | "other" | null;
  supplierName: string | null;
  supplierVatNumber: string | null;
  platform: string | null;
  invoiceNumber: string | null;
  issueDate: string | null;
  dueDate: string | null;
  paidDate: string | null;
  currency: string | null;
  vatNote: string | null;
  reverseCharge: boolean | null;
  total: number | null;
  lots: InvoiceLotValues[];
  fees: InvoiceFeeValues[];
}
export type InvoiceEdits = Partial<InvoiceValues>;

export const INVOICE_CHECK_CODES = ["TOTAL_MISMATCH", "PREMIUM_MISMATCH", "CURRENCY_MISSING", "NO_LOTS", "UNSUPPORTED_FIELDS"] as const;
export type InvoiceCheckCode = (typeof INVOICE_CHECK_CODES)[number];
/** One check result; ok=false means the named problem is present. Only TOTAL_MISMATCH blocks a confirmation. */
export interface InvoiceCheck { code: InvoiceCheckCode; ok: boolean; message: string; fields?: string[] }

const has = (edits: InvoiceEdits, key: keyof InvoiceValues) => Object.prototype.hasOwnProperty.call(edits, key) && edits[key] !== undefined;

function plainRow<K extends string>(row: Record<K, { value: unknown }>, names: readonly K[]) {
  return Object.fromEntries(names.map((n) => [n, row[n].value])) as any;
}

export function effectiveInvoiceValues(extraction: InvoiceExtraction, edits: InvoiceEdits = {}): InvoiceValues {
  const out: Record<string, unknown> = {};
  for (const name of INVOICE_HEADER_FIELD_NAMES) out[name] = has(edits, name) ? edits[name] : extraction[name].value;
  out.lots = has(edits, "lots") ? edits.lots : extraction.lots.map((l) => plainRow(l as any, INVOICE_LOT_FIELD_NAMES));
  out.fees = has(edits, "fees") ? edits.fees : extraction.fees.map((f) => plainRow(f as any, INVOICE_FEE_FIELD_NAMES));
  return out as unknown as InvoiceValues;
}

export function editedInvoiceFields(edits: InvoiceEdits = {}): string[] {
  return [...INVOICE_HEADER_FIELD_NAMES, "lots", "fees"].filter((k) => has(edits, k as keyof InvoiceValues));
}

/** Fields whose effective value comes from the model with no supporting evidence. Admin-edited values are the admin's own assertion. */
function unsupportedFields(extraction: InvoiceExtraction, edits: InvoiceEdits): string[] {
  const out: string[] = [];
  const missing = (f: { value: unknown; evidence: string | null }) => f.value !== null && (f.evidence === null || f.evidence.trim() === "");
  for (const name of INVOICE_HEADER_FIELD_NAMES) if (!has(edits, name) && missing(extraction[name])) out.push(name);
  if (!has(edits, "lots")) extraction.lots.forEach((lot, i) => { for (const n of INVOICE_LOT_FIELD_NAMES) if (missing(lot[n])) out.push(`lots[${i}].${n}`); });
  if (!has(edits, "fees")) extraction.fees.forEach((fee, i) => { for (const n of INVOICE_FEE_FIELD_NAMES) if (missing(fee[n])) out.push(`fees[${i}].${n}`); });
  return out;
}

export const toCents = (amount: number) => Math.round(amount * 100);
const fmt = (cents: number) => (cents / 100).toFixed(2);

export function checkInvoiceValues(values: InvoiceValues, unsupported: string[] = []): InvoiceCheck[] {
  const checks: InvoiceCheck[] = [];
  const lines = [...values.lots, ...values.fees];

  if (values.total === null) {
    checks.push({ code: "TOTAL_MISMATCH", ok: false, message: "The invoice total is missing" });
  } else if (lines.some((l) => l.amount === null)) {
    checks.push({ code: "TOTAL_MISMATCH", ok: false, message: "A lot or fee line has no amount" });
  } else {
    const sum = lines.reduce((acc, l) => acc + toCents(l.amount as number), 0);
    const total = toCents(values.total);
    checks.push(sum === total
      ? { code: "TOTAL_MISMATCH", ok: true, message: `Lots and fees add up to the total (${fmt(total)})` }
      : { code: "TOTAL_MISMATCH", ok: false, message: `Lots and fees add up to ${fmt(sum)}, but the total is ${fmt(total)}` });
  }

  values.fees.forEach((fee, i) => {
    if (fee.type !== "buyer_premium" || fee.percent === null) return;
    const field = `fees[${i}]`;
    const base = fee.lotNumber ? values.lots.filter((l) => l.lotNumber === fee.lotNumber) : values.lots;
    if (fee.amount === null || base.length === 0 || base.some((l) => l.amount === null)) {
      checks.push({ code: "PREMIUM_MISMATCH", ok: false, message: fee.lotNumber && base.length === 0 ? `Buyer's premium refers to lot ${fee.lotNumber}, which is not on the invoice` : "Buyer's premium cannot be verified: an amount is missing", fields: [field] });
      return;
    }
    const lotSum = base.reduce((acc, l) => acc + toCents(l.amount as number), 0) / 100;
    const expected = Math.round((lotSum * fee.percent) / 100);
    const ok = Math.abs(toCents(fee.amount) - expected * 100) <= 100;
    checks.push({ code: "PREMIUM_MISMATCH", ok, message: ok ? `Buyer's premium ${fee.percent}% matches (${expected})` : `Buyer's premium is ${fmt(toCents(fee.amount))}, expected about ${expected} (${fee.percent}% of ${lotSum})`, fields: [field] });
  });

  const currencyOk = typeof values.currency === "string" && values.currency.trim() !== "";
  checks.push({ code: "CURRENCY_MISSING", ok: currencyOk, message: currencyOk ? `Currency ${values.currency}` : "The currency is missing" });

  if (values.invoiceType === "auction") {
    const ok = values.lots.length > 0;
    checks.push({ code: "NO_LOTS", ok, message: ok ? `${values.lots.length} lot(s)` : "An auction invoice has no lots" });
  }

  checks.push(unsupported.length === 0
    ? { code: "UNSUPPORTED_FIELDS", ok: true, message: "Every read value has evidence" }
    : { code: "UNSUPPORTED_FIELDS", ok: false, message: "Some read values have no evidence in the document", fields: unsupported });
  return checks;
}

export function runInvoiceChecks(extraction: InvoiceExtraction, edits: InvoiceEdits = {}): InvoiceCheck[] {
  return checkInvoiceValues(effectiveInvoiceValues(extraction, edits), unsupportedFields(extraction, edits));
}

export const hasBlockingCheck = (checks: InvoiceCheck[]) => checks.some((c) => c.code === "TOTAL_MISMATCH" && !c.ok);

/** The invoice_intakes summary columns, refreshed from the effective values. invoice_type is NOT NULL: a null keeps the current type. */
export function denormalizedInvoiceColumns(values: InvoiceValues, currentInvoiceType: string) {
  const lotNumbers = [...new Set([...values.lots, ...values.fees].map((l) => l.lotNumber?.trim()).filter((n): n is string => !!n))];
  return {
    invoiceType: values.invoiceType ?? currentInvoiceType,
    supplierName: values.supplierName,
    supplierVatNumber: values.supplierVatNumber,
    platform: values.platform,
    invoiceNumber: values.invoiceNumber,
    issueDate: values.issueDate,
    paidDate: values.paidDate,
    currency: values.currency,
    totalOriginal: values.total,
    vatNote: values.vatNote,
    reverseCharge: values.reverseCharge,
    lotNumbers: lotNumbers.length ? JSON.stringify(lotNumbers) : null,
  };
}
