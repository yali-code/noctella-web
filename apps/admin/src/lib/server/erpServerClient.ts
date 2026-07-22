const ERP_KEY_HEADER = "X-Noctella-ERP-Key";

/**
 * Thrown when server-side ERP configuration is missing. Never includes the
 * key value itself — only states that configuration is absent — so it is
 * safe to surface in a generic error response.
 */
export class ErpServerConfigError extends Error {}

function backendBaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!url) throw new ErpServerConfigError("Backend API base URL is not configured");
  return url;
}

function erpKey(): string {
  const key = process.env.ERP_INTEGRATION_KEY;
  if (!key) throw new ErpServerConfigError("ERP integration key is not configured");
  return key;
}

/**
 * Fixed request headers only — never accepts a headers argument, so no
 * browser-supplied header (Cookie, Authorization, a spoofed
 * X-Noctella-ERP-Key, or anything else) can ever reach this object.
 */
export function buildErpRequestHeaders(): Record<string, string> {
  return { Accept: "application/json", [ERP_KEY_HEADER]: erpKey() };
}

/**
 * Fixed-template path builders. Each accepts only an order id segment, never
 * a full path or URL, so no caller can steer the backend target.
 */
export function salesSummaryPath(orderId: string): string {
  return `/api/erp/orders/${encodeURIComponent(orderId)}/sales-summary`;
}

export function invoicesPath(orderId: string): string {
  return `/api/erp/orders/${encodeURIComponent(orderId)}/invoices`;
}

export function financeOrderPath(orderId: string): string {
  return `/api/erp/finance/orders/${encodeURIComponent(orderId)}`;
}

export function createInvoiceDraftPath(orderId: string): string {
  return `/api/erp/commands/orders/${encodeURIComponent(orderId)}/invoices/create`;
}

export function issueInvoicePath(invoiceId: string): string {
  return `/api/erp/commands/invoices/${encodeURIComponent(invoiceId)}/issue`;
}

/**
 * Forwards a GET request to one of the fixed backend paths above, attaching
 * the server-only ERP key. Fails closed (throws before any fetch) if the key
 * or backend base URL is missing.
 */
export async function fetchErpBackend(path: string): Promise<Response> {
  const base = backendBaseUrl();
  const headers = buildErpRequestHeaders();
  return fetch(`${base}${path}`, { method: "GET", headers, cache: "no-store" });
}

/**
 * Forwards a POST request (JSON body passthrough) to one of the fixed
 * backend command paths above, attaching the server-only ERP key. Fails
 * closed (throws before any fetch) if the key or backend base URL is
 * missing.
 */
export async function postErpBackend(path: string, body: unknown): Promise<Response> {
  const base = backendBaseUrl();
  const headers = { ...buildErpRequestHeaders(), "Content-Type": "application/json" };
  return fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body), cache: "no-store" });
}
