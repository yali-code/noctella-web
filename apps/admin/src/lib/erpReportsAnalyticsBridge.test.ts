import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ApiError } from "./api";
import { comparisonLabels, erpReportsApi, exportUrl, mapBreakdowns, mapCompletenessWarnings, mapCustomer, mapDashboard, mapFinance, mapInventory, mapMetric, mapPurchasing, mapReturnRefund, mapSalesChannel, mapSeries, mapShipping, mapSupplier, mapWarehouse, periodLabels, query, redactSafeError } from "./erpReportsAnalyticsBridge";

const report={ issues:[{code:"UNKNOWN",message:"Missing fee"}], metrics:{grossRevenue:10}, series:[{period:"2026-01",value:1,comparisonValue:0,changePercent:null}], breakdowns:[{dimension:"channel",key:"Direct",label:"Direct",metrics:[]}], customers:[{id:"c",email:"secret@example.com",phone:"123",address:"raw"}], sections:{notice:"Operational"} };

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  process.env.ERP_INTEGRATION_KEY = "test-erp-key";
  process.env.NEXT_PUBLIC_API_BASE_URL = "http://backend.internal:4000";
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("ERP reports analytics bridge network behavior (Sprint 55B)", () => {
  it("does not contain or call the old fake stub", () => {
    const source = readFileSync(new URL("./erpReportsAnalyticsBridge.ts", import.meta.url), "utf8");
    expect(source).not.toContain('async (path:string) => ({ path })');
    expect(source).not.toMatch(/const api = \{ get:/);
  });

  it("uses the real (server-only ERP) client for the dashboard request, with the ERP key header", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ inventory: { activeProductCount: 3 } }), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await erpReportsApi.dashboard();
    expect(mockFetch).toHaveBeenCalledWith(
      "http://backend.internal:4000/api/erp/reports/dashboard",
      expect.objectContaining({ headers: { Accept: "application/json", "X-Noctella-ERP-Key": "test-erp-key" } }),
    );
    expect(result).toEqual({ inventory: { activeProductCount: 3 } });
  });

  it("maps a representative dashboard response correctly end-to-end", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ inventory: { activeProductCount: 3 }, sales: { grossRevenue: 300 }, issues: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    const mapped = mapDashboard(await erpReportsApi.dashboard());
    expect(mapped.inventory).toEqual({ activeProductCount: 3 });
    expect(mapped.sales).toEqual({ grossRevenue: 300 });
  });

  it("maps a representative tabular (inventory) report response correctly end-to-end", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ metrics: { activeProductCount: 3 }, breakdowns: [{ dimension: "category", key: "Direct", label: "Direct", metrics: [] }], issues: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    const mapped = mapInventory(await erpReportsApi.report("inventory"));
    expect(mapped.metrics).toEqual({ activeProductCount: 3 });
    expect(mapped.breakdowns).toHaveLength(1);
  });

  it("preserves query parameters when calling a report", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    await erpReportsApi.report("sales", { period: "ThisMonth", channel: "Direct" });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://backend.internal:4000/api/erp/reports/sales?channel=Direct&period=ThisMonth",
      expect.anything(),
    );
  });

  it("propagates backend errors as ApiError", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async () => new Response(JSON.stringify({ error: "Report range is too large" }), { status: 413, headers: { "content-type": "application/json" } }));
    await expect(erpReportsApi.dashboard()).rejects.toBeInstanceOf(ApiError);
    await expect(erpReportsApi.dashboard()).rejects.toMatchObject({ status: 413, message: "Report range is too large" });
  });

  it("export URL points at the same-origin admin proxy, not the direct backend", () => {
    expect(exportUrl("inventory", "json")).toBe("/api/erp/reports/inventory/export?format=json");
    expect(exportUrl("inventory", "csv", { period: "ThisMonth" })).toBe("/api/erp/reports/inventory/export?format=csv&period=ThisMonth");
  });
});

describe("ERP reports analytics bridge admin focused coverage", () => {
  it("builds deterministic filter/query strings",()=>{ expect(query("/erp/reports/sales",{period:"Last30Days",channel:"Direct",empty:""})).toBe("/erp/reports/sales?channel=Direct&period=Last30Days"); expect(erpReportsApi.exportUrl("sales","json",{period:"Today"})).toContain("format=json"); });
  it("maps period and comparison labels",()=>{ expect(periodLabels.Today).toBe("Today"); expect(periodLabels.Last30Days).toContain("30"); expect(comparisonLabels.None).toContain("No"); expect(comparisonLabels.PreviousPeriod).toContain("period"); expect(comparisonLabels.PreviousYear).toContain("year"); });
  it("maps dashboard family",()=>{ const r=mapDashboard({inventory:{activeProductCount:1},purchasing:{},sales:{},returnsRefunds:{},customers:{},warehouse:{},issues:report.issues}); expect(r.inventory.activeProductCount).toBe(1); expect(r.warnings[0]).toContain("UNKNOWN"); });
  it("maps inventory family with completeness warnings",()=>{ const r=mapInventory(report); expect(r.metrics.grossRevenue).toBe(10); expect(r.breakdowns[0].dimension).toBe("channel"); expect(r.warnings[0]).toContain("Missing fee"); });
  it("maps purchasing and supplier families",()=>{ expect(mapPurchasing(report).series[0].label).toBe("2026-01"); expect(mapSupplier({suppliers:[{id:"s"}],supplier:{id:"s"}}).supplier.id).toBe("s"); });
  it("maps sales/channel and finance families",()=>{ expect(mapSalesChannel({...report,channel:"eBay"}).channel).toBe("eBay"); expect(mapFinance(report).notice).toBe("Operational"); });
  it("maps customer family and masks PII",()=>{ const r=mapCustomer(report); expect(r.customers[0].email).toBeUndefined(); expect(r.customers[0].phone).toBeUndefined(); expect(r.customers[0].address).toBeUndefined(); expect(r.customers[0].maskedEmail).toBe("se***"); });
  it("maps return/refund, shipping and warehouse families",()=>{ expect(mapReturnRefund(report).breakdowns).toHaveLength(1); expect(mapShipping(report).metrics.grossRevenue).toBe(10); expect(mapWarehouse(report).breakdowns[0].key).toBe("Direct"); });
  it("maps metric, series and breakdown helpers",()=>{ expect(mapMetric({a:null},"a").complete).toBe(false); expect(mapSeries(report)[0]).toMatchObject({label:"2026-01",value:1,comparison:0,changePercent:null}); expect(mapBreakdowns(report)[0].label).toBe("Direct"); });
  it("builds JSON and CSV export URLs",()=>{ expect(exportUrl("inventory","json")).toContain("format=json"); expect(exportUrl("inventory","csv",{period:"ThisMonth"})).toContain("period=ThisMonth"); });
  it("redacts secrets and customer identifiers from errors",()=>{ const safe=redactSafeError("bad secret@example.com abcdefghijklmnopqrstuvwxyz token_abcdefghijklmnopqrstuvwxyz"); expect(safe).not.toContain("secret@example.com"); expect(safe).toContain("[redacted]"); });
  it("does not render raw report rows or secrets in helper projections",()=>{ const serialized=JSON.stringify(mapCustomer(report)); expect(serialized).not.toContain("secret@example.com"); expect(serialized).not.toContain("raw"); });
});
