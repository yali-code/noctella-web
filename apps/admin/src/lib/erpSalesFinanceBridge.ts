import { api, ApiError } from "./api";
export function maskCustomer(customer:any){ return { ...customer, email: customer.email ? "[redacted]" : customer.maskedEmail ?? null }; }
export function mapSale(row:any){ return { id:row.centralOrderId, orderNumber:row.orderNumber, channel:row.channel, customer:maskCustomer(row.customer??{}), total:row.financials?.grossRevenue??0, adjustedProfit:row.financials?.adjustedProfit??null, completeness:row.financials?.adjustedCompleteness??"Incomplete", invoice:row.invoiceNumber??row.invoiceStatus??"—", href:`/orders/${row.centralOrderId}` }; }
export function mapInvoice(row:any){ return { id:row.id, orderId:row.orderId, customerId:row.customerId, status:row.status, type:row.invoiceType, invoiceNumber:row.invoiceNumber??"Draft", dates:[row.issuedAt,row.dueAt,row.paidAt].filter(Boolean).join(" / ")||"—", total:`€${Number(row.totalAmount??0).toFixed(2)}`, href:`/invoices/${row.id}`, orderHref:`/orders/${row.orderId}` }; }
export function invoiceActionEligibility(inv:any){ return { update: inv.status === "Draft", issue: inv.status === "Draft", cancel: ["Draft","Issued"].includes(inv.status), void: inv.status === "Issued", markPaid: inv.status === "Issued" }; }
export function invoiceCommand(idempotencyKey:string,payload:any={}){ return { idempotencyKey, payload }; }
export function mapFinanceSummary(s:any){ return { grossRevenue:s.grossRevenue??0,totalRefunds:s.totalRefunds??0,netRevenue:s.netRevenue??0,itemCost:s.itemCost??0,fees:s.fees,shippingCost:s.shippingCost,profit:s.profit,adjustedProfit:s.adjustedProfit,completeness:s.completeness??"Incomplete" }; }
export function mapRefundSummary(s:any){ return { orderId:s.orderId,totalRefunded:s.totalRefunded??0,refunds:s.refunds??[], href:`/refunds?orderId=${s.orderId}` }; }
export function mapReversalSummary(s:any){ return { orderId:s.orderId,reversed:!!s.reversed,reversals:s.reversals??[], href:`/returns?orderId=${s.orderId}` }; }
export function redactSafeError(input:unknown){ return JSON.stringify(input??{}).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+/gi,"[redacted-email]").replace(/invoice(Line|s)?\":\s*\[[^\]]+\]/gi,"invoice\":[redacted]"); }
export function buildSalesFinanceQuery(filters:any){ const q=new URLSearchParams(); for(const [k,v] of Object.entries(filters)) if(v!=null&&v!=="") q.set(k,String(v)); return q.toString(); }
export const salesFinanceApi={ sales:(q="")=>api.get<any>(`/api/erp/sales${q?`?${q}`:""}`), sale:(id:string)=>api.get<any>(`/api/erp/sales/${id}`), invoices:(q="")=>api.get<any>(`/api/erp/invoices${q?`?${q}`:""}`), invoice:(id:string)=>api.get<any>(`/api/erp/invoices/${id}`), financeSummary:(q="")=>api.get<any>(`/api/erp/finance/summary${q?`?${q}`:""}`), financeOrder:(id:string)=>api.get<any>(`/api/erp/finance/orders/${id}`)};

/**
 * Deliberately not `api.post`: that client targets NEXT_PUBLIC_API_BASE_URL
 * (the direct backend), which the browser cannot authenticate against. This
 * calls the same-origin Admin ERP proxy (Sprint 42A) instead, which injects
 * the ERP key server-side.
 */
export async function createInvoiceDraft(orderId: string): Promise<any> {
  const res = await fetch(`/api/erp/commands/orders/${orderId}/invoices/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), payload: {} }),
  });
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : undefined;
  if (!res.ok) throw new ApiError(body?.error ?? res.statusText, res.status, body?.details);
  return body;
}

/**
 * Same rationale as createInvoiceDraft: uses the same-origin Admin ERP proxy
 * directly rather than `api.post`, which would target the direct backend.
 */
export async function issueInvoice(invoiceId: string): Promise<any> {
  const res = await fetch(`/api/erp/commands/invoices/${invoiceId}/issue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), payload: {} }),
  });
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : undefined;
  if (!res.ok) throw new ApiError(body?.error ?? res.statusText, res.status, body?.details);
  return body;
}

/**
 * Same rationale as createInvoiceDraft/issueInvoice: uses the same-origin
 * Admin ERP proxy directly rather than `api.post`, which would target the
 * direct backend.
 */
export async function markInvoicePaid(invoiceId: string): Promise<any> {
  const res = await fetch(`/api/erp/commands/invoices/${invoiceId}/mark-paid`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), payload: {} }),
  });
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : undefined;
  if (!res.ok) throw new ApiError(body?.error ?? res.statusText, res.status, body?.details);
  return body;
}
