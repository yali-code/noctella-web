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
}

export interface InvoiceCostSetDetail extends InvoiceCostSet {
  intakes: InvoiceIntake[];
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
  fileUrl: (id: string) => `/api/erp/invoice-intakes/${encodeURIComponent(id)}/file`,
};

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
