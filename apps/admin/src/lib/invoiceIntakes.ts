import { ApiError } from "./api";

/**
 * PHASE-2A: invoice cost sets and their uploaded invoice files. Calls the admin's own same-origin
 * proxies (apps/admin/src/app/api/erp/{invoice-cost-sets,invoice-intakes}/**), which inject the ERP
 * key server-side - same pattern as erpPurchasingBridge.ts. No AI, FX or allocation in this phase.
 */
export const INVOICE_TYPES = ["auction", "transport", "forwarder", "other"] as const;
export type InvoiceType = (typeof INVOICE_TYPES)[number];

export interface InvoiceCostSet {
  id: string;
  status: "open" | "approved" | "cancelled";
  title: string;
  purchaseId: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InvoiceIntake {
  id: string;
  costSetId: string;
  invoiceType: InvoiceType;
  status: "uploaded" | "extracted" | "reviewed" | "cancelled";
  fileSha256: string;
  fileSizeBytes: number;
  fileMime: string;
  originalFilenameSanitized: string | null;
  createdAt: string;
  updatedAt: string;
  /** PHASE-2B: null until the invoice has been read by AI. */
  review?: InvoiceIntakeReview | null;
  /** PHASE-2C: summary columns, official rate and bank debit. */
  invoiceNumber?: string | null;
  currency?: string | null;
  paidDate?: string | null;
  totalOriginal?: number | null;
  fxRate?: number | null;
  fxRateDate?: string | null;
  fxSource?: string | null;
  bankDebitEur?: number | null;
  fx?: { officialEur: number; fxDiffEur: number | null } | null;
}

/** PHASE-2C: one selected product of a cost set with its weight and stored allocation. */
export interface InvoiceCostSetItem {
  productId: string;
  sku: string | null;
  title: string | null;
  aiSuggestedPriceEur: number | null;
  purchaseCost: number | null;
  valueWeightEur: number | null;
  /** "fallback": the average of the set's AI estimates (or 1 when none), for an item without an AI estimate. */
  weightSource: "ai" | "admin" | "fallback" | null;
  allocLotEur: number | null;
  allocHammerFeeEur: number | null;
  allocPremiumEur: number | null;
  allocTransportEur: number | null;
  allocForwarderEur: number | null;
  allocFxDiffEur: number | null;
  allocTotalEur: number | null;
}

export interface CostSetProductCandidate { productId: string; sku: string; title: string; createdAt: string; purchaseCost: number | null; aiSuggestedPriceEur: number | null }
export interface CostSetIssue { code: string; message: string; intakeId?: string; productId?: string }
export interface CostSetPreview {
  issues: CostSetIssue[];
  warnings: CostSetIssue[];
  intakes: Array<{ intakeId: string; invoiceType: string; invoiceNumber: string | null; currency: string | null; totalOriginal: number | null; fxRate: number | null; fxRateDate: string | null; fxSource: string | null; officialEur: number; bankDebitEur: number; fxDiffEur: number }>;
  items: Array<{ productId: string; sku: string | null; title: string | null; lotEur: number; hammerFeeEur: number; premiumEur: number; transportEur: number; forwarderEur: number; fxDiffEur: number; totalEur: number }>;
  totalBankDebitEur: number;
  totalAllocatedEur: number;
}

/** PHASE-2B: AI extraction + admin review. Mirrors the API's review view (use-cases/invoice-intake). */
export const INVOICE_FEE_TYPES = ["hammer_fee", "buyer_premium", "transport", "other"] as const;
export type InvoiceFeeType = (typeof INVOICE_FEE_TYPES)[number];
export const LOW_CONFIDENCE = 0.7;

export interface ExtractedField<T> { value: T | null; evidence: string | null; confidence: number }
export interface InvoiceLotValues { lotNumber: string | null; title: string | null; itemCountHint: number | null; amount: number | null }
export interface InvoiceFeeValues { type: InvoiceFeeType | null; label: string | null; amount: number | null; percent: number | null; lotNumber: string | null }
export interface InvoiceValues {
  invoiceType: InvoiceType | null;
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
export type InvoiceHeaderField = Exclude<keyof InvoiceValues, "lots" | "fees">;
export type InvoiceExtraction = { [K in InvoiceHeaderField]: ExtractedField<InvoiceValues[K]> } & {
  lots: Array<{ [K in keyof InvoiceLotValues]: ExtractedField<InvoiceLotValues[K]> }>;
  fees: Array<{ [K in keyof InvoiceFeeValues]: ExtractedField<InvoiceFeeValues[K]> }>;
};
export interface InvoiceCheck { code: "TOTAL_MISMATCH" | "PREMIUM_MISMATCH" | "CURRENCY_MISSING" | "NO_LOTS" | "UNSUPPORTED_FIELDS"; ok: boolean; message: string; fields?: string[] }
export interface InvoiceIntakeReview {
  extracted: InvoiceExtraction;
  effective: InvoiceValues;
  editedFields: string[];
  checks: InvoiceCheck[];
  model: string | null;
  extractedAt: string | null;
  editedAt: string | null;
}

export const hasTotalMismatch = (checks: InvoiceCheck[]) => checks.some((c) => c.code === "TOTAL_MISMATCH" && !c.ok);

export interface InvoiceCostSetDetail extends InvoiceCostSet {
  intakes: InvoiceIntake[];
  /** PHASE-2C: absent on responses from before 2C. */
  items?: InvoiceCostSetItem[];
}

async function readJson<T>(res: Response): Promise<T> {
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : undefined;
  if (!res.ok) throw new ApiError((body as any)?.error ?? res.statusText, res.status, (body as any)?.details);
  return body as T;
}

function postJson<T>(path: string, body: unknown): Promise<T> {
  return fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(readJson<T>);
}

export const invoiceIntakeApi = {
  listCostSets: (q = "") => fetch(`/api/erp/invoice-cost-sets${q ? `?${q}` : ""}`).then(readJson<{ items: InvoiceCostSet[]; total: number; page: number; pageSize: number }>),
  getCostSet: (id: string) => fetch(`/api/erp/invoice-cost-sets/${encodeURIComponent(id)}`).then(readJson<InvoiceCostSetDetail>),
  createCostSet: (input: { title: string; notes?: string | null }) => postJson<InvoiceCostSet>("/api/erp/invoice-cost-sets", input),
  cancelCostSet: (id: string) => postJson<InvoiceCostSet>(`/api/erp/invoice-cost-sets/${encodeURIComponent(id)}/cancel`, {}),
  uploadFile: (costSetId: string, invoiceType: InvoiceType, file: File) => {
    const form = new FormData();
    form.append("invoiceType", invoiceType);
    form.append("file", file);
    return fetch(`/api/erp/invoice-cost-sets/${encodeURIComponent(costSetId)}/files`, { method: "POST", body: form }).then(readJson<InvoiceIntake>);
  },
  cancelIntake: (id: string) => postJson<InvoiceIntake>(`/api/erp/invoice-intakes/${encodeURIComponent(id)}/cancel`, {}),
  extractIntake: (id: string) => postJson<InvoiceIntake>(`/api/erp/invoice-intakes/${encodeURIComponent(id)}/extract`, {}),
  reviewIntake: (id: string, edits: Partial<InvoiceValues>, confirm: boolean) =>
    postJson<InvoiceIntake>(`/api/erp/invoice-intakes/${encodeURIComponent(id)}/review`, { edits, confirm }),
  fileUrl: (id: string) => `/api/erp/invoice-intakes/${encodeURIComponent(id)}/file`,
  setBankDebit: (id: string, bankDebitEur: number) => postJson<InvoiceIntake>(`/api/erp/invoice-intakes/${encodeURIComponent(id)}/bank-debit`, { bankDebitEur }),
  productCandidates: (costSetId: string, q: string) =>
    fetch(`/api/erp/invoice-cost-sets/${encodeURIComponent(costSetId)}/product-candidates${q ? `?${new URLSearchParams({ q })}` : ""}`).then(readJson<{ items: CostSetProductCandidate[] }>),
  setProducts: (costSetId: string, items: Array<{ productId: string; valueWeightEur?: number | null }>) =>
    fetch(`/api/erp/invoice-cost-sets/${encodeURIComponent(costSetId)}/products`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) }).then(readJson<{ items: InvoiceCostSetItem[] }>),
  preview: (costSetId: string) => postJson<CostSetPreview>(`/api/erp/invoice-cost-sets/${encodeURIComponent(costSetId)}/preview`, {}),
  approve: (costSetId: string) => postJson<InvoiceCostSet>(`/api/erp/invoice-cost-sets/${encodeURIComponent(costSetId)}/approve`, {}),
};

export const formatEur = (v: number | null | undefined) => (v == null ? "—" : v.toFixed(2));

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
