import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { customerApi, executeMerge, mapAnalytics, mapCustomer, mapTimelineItem, maskCustomerValue, redactCustomerError, searchMergeCandidates } from "./erpCustomerBridge";

describe("erp customer bridge admin mappings", () => {
  it("maps customers, timeline, analytics and redacts sensitive errors", () => {
    expect(mapCustomer({ id:"c1", name:"Ada", email:"a***@x.test", erpReferenceId:"erp" }).href).toBe("/customers/c1");
    expect(mapTimelineItem({ type:"Order", entityId:"o1", occurredAt:"now" }).readOnly).toBe(true);
    expect(mapAnalytics({ lifetimeValue:12, averageOrderValue:null }).lifetimeValue).toBe("€12.00");
    expect(maskCustomerValue("abcdef")).toBe("a***f");
    expect(redactCustomerError("token=abc tax=123")).not.toContain("abc");
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("customerApi reads (Sprint 61B - proxy wiring)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("list calls the same-origin proxy path, not the direct ERP backend", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ items: [] }));
    await customerApi.list("search=ada");
    expect(mockFetch.mock.calls[0][0]).toBe("/api/erp/customers?search=ada");
  });

  it("list omits the query string entirely when no filter is given", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ items: [] }));
    await customerApi.list();
    expect(mockFetch.mock.calls[0][0]).toBe("/api/erp/customers");
  });

  it("detail/history/statistics/preferences/notes each call their own same-origin proxy path", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockImplementation(async () => jsonResponse({}));
    await customerApi.detail("c1");
    await customerApi.history("c1");
    await customerApi.statistics("c1");
    await customerApi.preferences("c1");
    await customerApi.notes("c1");
    expect(mockFetch.mock.calls.map((c) => c[0])).toEqual([
      "/api/erp/customers/c1",
      "/api/erp/customers/c1/history",
      "/api/erp/customers/c1/statistics",
      "/api/erp/customers/c1/preferences",
      "/api/erp/customers/c1/notes",
    ]);
  });

  it("no customerApi read ever targets the direct ERP backend host", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockImplementation(async () => jsonResponse({}));
    await customerApi.list();
    await customerApi.detail("c1");
    await customerApi.history("c1");
    await customerApi.statistics("c1");
    await customerApi.preferences("c1");
    await customerApi.notes("c1");
    for (const call of mockFetch.mock.calls) {
      expect(String(call[0])).toMatch(/^\/api\/erp\/customers/);
      expect(String(call[0])).not.toContain("://");
    }
  });

  it("propagates a structured, redacted ApiError on failure", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async () => jsonResponse({ error: "backend failure token=secret123" }, 401));
    await expect(customerApi.detail("c1")).rejects.toBeInstanceOf(ApiError);
    await expect(customerApi.detail("c1")).rejects.toMatchObject({ status: 401 });
    const err = await customerApi.detail("c1").catch((e) => e);
    expect(err.message).not.toContain("secret123");
  });
});

describe("searchMergeCandidates (Sprint 61B)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("posts to the merge-candidates proxy with the criteria wrapped as payload", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ candidates: [], autoMerge: false, executionRequired: true }));
    await searchMergeCandidates({ email: "ada@example.com" });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/erp/commands/customers/merge-candidates");
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({ payload: { email: "ada@example.com" } });
  });

  it("does not invent unsupported search fields beyond what is passed in", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ candidates: [] }));
    await searchMergeCandidates({ vatNumber: "VAT1" });
    const init = mockFetch.mock.calls[0][1];
    expect(JSON.parse(init!.body as string)).toEqual({ payload: { vatNumber: "VAT1" } });
  });
});

describe("executeMerge (Sprint 61B)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("posts the caller-supplied idempotency key and target/source ids, never generating its own key", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ status: "Completed", idempotent: false, sourceCustomerId: "a", targetCustomerId: "b" }));
    await executeMerge({ sourceCustomerId: "a", targetCustomerId: "b", idempotencyKey: "merge-key-1" });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/erp/commands/customers/merge");
    expect(JSON.parse(init!.body as string)).toEqual({
      idempotencyKey: "merge-key-1",
      payload: { sourceCustomerId: "a", targetCustomerId: "b" },
    });
  });

  it("surfaces the idempotent flag from the backend response unchanged", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ status: "Completed", idempotent: true, sourceCustomerId: "a", targetCustomerId: "b" }));
    const result = await executeMerge({ sourceCustomerId: "a", targetCustomerId: "b", idempotencyKey: "merge-key-1" });
    expect(result.idempotent).toBe(true);
  });

  it("propagates a structured error (e.g. a conflicting replay) from the backend", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ error: "Idempotency key was already used with a different payload" }, 409));
    await expect(executeMerge({ sourceCustomerId: "a", targetCustomerId: "c", idempotencyKey: "merge-key-1" })).rejects.toMatchObject({ status: 409 });
  });
});
