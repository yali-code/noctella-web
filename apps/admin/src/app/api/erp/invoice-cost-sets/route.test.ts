import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";
import { GET as GET_DETAIL } from "./[id]/route";
import { POST as CANCEL_SET } from "./[id]/cancel/route";
import { POST as UPLOAD } from "./[id]/files/route";
import { POST as CANCEL_INTAKE } from "../invoice-intakes/[id]/cancel/route";
import { GET as GET_FILE } from "../invoice-intakes/[id]/file/route";
import { POST as EXTRACT } from "../invoice-intakes/[id]/extract/route";
import { POST as REVIEW } from "../invoice-intakes/[id]/review/route";
import { POST as BANK_DEBIT } from "../invoice-intakes/[id]/bank-debit/route";
import { GET as CANDIDATES } from "./[id]/product-candidates/route";
import { PUT as PRODUCTS } from "./[id]/products/route";
import { POST as PREVIEW } from "./[id]/preview/route";
import { POST as APPROVE } from "./[id]/approve/route";

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  process.env.ERP_INTEGRATION_KEY = "test-erp-key";
  process.env.NEXT_PUBLIC_API_BASE_URL = "http://backend.internal:4000";
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const keyHeader = expect.objectContaining({ headers: expect.objectContaining({ "X-Noctella-ERP-Key": "test-erp-key" }) });

describe("invoice cost set proxy routes (PHASE-2A)", () => {
  it("lists cost sets with the query string and the server-side ERP key", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(json({ items: [], total: 0, page: 1, pageSize: 20 }));
    const res = await GET(new Request("http://admin.local/api/erp/invoice-cost-sets?status=open"));
    expect(mockFetch).toHaveBeenCalledWith("http://backend.internal:4000/api/erp/invoice-cost-sets?status=open", keyHeader);
    expect(res.status).toBe(200);
  });

  it("creates a cost set by forwarding the JSON body", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(json({ id: "cs1", status: "open" }, 201));
    const res = await POST(new Request("http://admin.local/api/erp/invoice-cost-sets", { method: "POST", body: JSON.stringify({ title: "Lot 1" }) }));
    expect(mockFetch).toHaveBeenCalledWith("http://backend.internal:4000/api/erp/invoice-cost-sets", expect.objectContaining({ method: "POST", body: JSON.stringify({ title: "Lot 1" }) }));
    expect(res.status).toBe(201);
  });

  it("gets a cost set detail and encodes the id segment", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(json({ id: "a/b", intakes: [] }));
    await GET_DETAIL(new Request("http://admin.local/x"), { params: { id: "a/b" } });
    expect(mockFetch).toHaveBeenCalledWith("http://backend.internal:4000/api/erp/invoice-cost-sets/a%2Fb", keyHeader);
  });

  it("cancels a cost set and an intake", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockImplementation(async () => json({ status: "cancelled" }));
    await CANCEL_SET(new Request("http://admin.local/x", { method: "POST" }), { params: { id: "cs1" } });
    await CANCEL_INTAKE(new Request("http://admin.local/x", { method: "POST" }), { params: { id: "in1" } });
    expect(mockFetch).toHaveBeenNthCalledWith(1, "http://backend.internal:4000/api/erp/invoice-cost-sets/cs1/cancel", expect.objectContaining({ method: "POST" }));
    expect(mockFetch).toHaveBeenNthCalledWith(2, "http://backend.internal:4000/api/erp/invoice-intakes/in1/cancel", expect.objectContaining({ method: "POST" }));
  });

  it("passes a multipart upload through with only file and invoiceType", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(json({ id: "in1", status: "uploaded" }, 201));
    const form = new FormData();
    form.append("invoiceType", "auction");
    form.append("file", new File([Buffer.from("%PDF-1.4")], "inv.pdf", { type: "application/pdf" }));
    form.append("extra", "ignored");
    const res = await UPLOAD(new Request("http://admin.local/x", { method: "POST", body: form }), { params: { id: "cs1" } });
    expect(res.status).toBe(201);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://backend.internal:4000/api/erp/invoice-cost-sets/cs1/files");
    expect((init.headers as Record<string, string>)["X-Noctella-ERP-Key"]).toBe("test-erp-key");
    const sent = init.body as FormData;
    expect(sent.get("invoiceType")).toBe("auction");
    expect((sent.get("file") as File).name).toBe("inv.pdf");
    expect(sent.has("extra")).toBe(false);
  });

  it("rejects an upload without a file and never calls fetch", async () => {
    const mockFetch = vi.spyOn(global, "fetch");
    const form = new FormData();
    form.append("invoiceType", "auction");
    const res = await UPLOAD(new Request("http://admin.local/x", { method: "POST", body: form }), { params: { id: "cs1" } });
    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("streams the invoice file inline with nosniff", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(new Response(Buffer.from("%PDF-1.4 body"), { status: 200, headers: { "content-type": "application/pdf", "content-disposition": 'inline; filename="invoice-in1.pdf"' } }));
    const res = await GET_FILE(new Request("http://admin.local/x"), { params: { id: "in1" } });
    expect(mockFetch).toHaveBeenCalledWith("http://backend.internal:4000/api/erp/invoice-intakes/in1/file", keyHeader);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/^inline/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("%PDF-1.4 body");
  });

  it("passes a file-route error through and refuses an unexpected content type", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(json({ error: "Invoice intake not found" }, 404));
    expect((await GET_FILE(new Request("http://admin.local/x"), { params: { id: "missing" } })).status).toBe(404);
    vi.spyOn(global, "fetch").mockResolvedValueOnce(new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }));
    const res = await GET_FILE(new Request("http://admin.local/x"), { params: { id: "in1" } });
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("<html>");
  });

  it("PHASE-2B: forwards extract and review to the fixed backend paths with the server-side key", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockImplementation(async () => json({ id: "in1", status: "extracted" }));
    const extract = await EXTRACT(new Request("http://admin.local/x", { method: "POST", body: JSON.stringify({ injected: true }) }), { params: { id: "in/1" } });
    expect(extract.status).toBe(200);
    const body = { edits: { invoiceType: "transport" }, confirm: true };
    await REVIEW(new Request("http://admin.local/x", { method: "POST", body: JSON.stringify(body) }), { params: { id: "in1" } });
    expect(mockFetch).toHaveBeenNthCalledWith(1, "http://backend.internal:4000/api/erp/invoice-intakes/in%2F1/extract", expect.objectContaining({ method: "POST", body: "{}" }));
    expect(mockFetch).toHaveBeenNthCalledWith(2, "http://backend.internal:4000/api/erp/invoice-intakes/in1/review", expect.objectContaining({ method: "POST", body: JSON.stringify(body) }));
    expect(mockFetch).toHaveBeenCalledWith(expect.any(String), keyHeader);
  });

  it("PHASE-2B: passes a review 409 with its checks through unchanged", async () => {
    const conflict = { error: "The invoice cannot be confirmed while the total does not match its lines", code: "INVOICE_REVIEW_CHECKS_FAILED", checks: [{ code: "TOTAL_MISMATCH", ok: false, message: "x" }] };
    vi.spyOn(global, "fetch").mockResolvedValue(json(conflict, 409));
    const res = await REVIEW(new Request("http://admin.local/x", { method: "POST", body: JSON.stringify({ edits: {}, confirm: true }) }), { params: { id: "in1" } });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(conflict);
  });

  it("PHASE-2C: forwards bank debit, products (PUT), preview and approve with the ERP key", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockImplementation(async () => json({ ok: true }));
    await BANK_DEBIT(new Request("http://admin.local/x", { method: "POST", body: JSON.stringify({ bankDebitEur: 109.65 }) }), { params: { id: "in1" } });
    const items = { items: [{ productId: "p1", valueWeightEur: 20 }] };
    await PRODUCTS(new Request("http://admin.local/x", { method: "PUT", body: JSON.stringify(items) }), { params: { id: "cs/1" } });
    await PREVIEW(new Request("http://admin.local/x", { method: "POST", body: JSON.stringify({ injected: true }) }), { params: { id: "cs1" } });
    await APPROVE(new Request("http://admin.local/x", { method: "POST", body: JSON.stringify({ approvedBy: "spoof" }) }), { params: { id: "cs1" } });
    expect(mockFetch).toHaveBeenNthCalledWith(1, "http://backend.internal:4000/api/erp/invoice-intakes/in1/bank-debit", expect.objectContaining({ method: "POST", body: JSON.stringify({ bankDebitEur: 109.65 }) }));
    expect(mockFetch).toHaveBeenNthCalledWith(2, "http://backend.internal:4000/api/erp/invoice-cost-sets/cs%2F1/products", expect.objectContaining({ method: "PUT", body: JSON.stringify(items) }));
    expect(mockFetch).toHaveBeenNthCalledWith(3, "http://backend.internal:4000/api/erp/invoice-cost-sets/cs1/preview", expect.objectContaining({ method: "POST", body: "{}" }));
    expect(mockFetch).toHaveBeenNthCalledWith(4, "http://backend.internal:4000/api/erp/invoice-cost-sets/cs1/approve", expect.objectContaining({ method: "POST", body: "{}" }));
    for (const call of mockFetch.mock.calls) expect(call[1]).toEqual(expect.objectContaining({ headers: expect.objectContaining({ "X-Noctella-ERP-Key": "test-erp-key" }) }));
  });

  it("PHASE-2C: the candidate search forwards only q", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(json({ items: [] }));
    await CANDIDATES(new Request("http://admin.local/x?q=cam 1&limit=9999"), { params: { id: "cs1" } });
    await CANDIDATES(new Request("http://admin.local/x"), { params: { id: "cs1" } });
    expect(mockFetch).toHaveBeenNthCalledWith(1, "http://backend.internal:4000/api/erp/invoice-cost-sets/cs1/product-candidates?q=cam+1", keyHeader);
    expect(mockFetch).toHaveBeenNthCalledWith(2, "http://backend.internal:4000/api/erp/invoice-cost-sets/cs1/product-candidates", keyHeader);
  });

  it("fails closed without the ERP key and never calls fetch", async () => {
    delete process.env.ERP_INTEGRATION_KEY;
    const mockFetch = vi.spyOn(global, "fetch");
    expect((await GET(new Request("http://admin.local/api/erp/invoice-cost-sets"))).status).toBe(500);
    expect((await GET_FILE(new Request("http://admin.local/x"), { params: { id: "in1" } })).status).toBe(500);
    expect((await APPROVE(new Request("http://admin.local/x", { method: "POST" }), { params: { id: "cs1" } })).status).toBe(500);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
