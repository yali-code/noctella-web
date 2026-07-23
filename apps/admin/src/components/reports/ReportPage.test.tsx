import { describe, expect, it, vi, afterEach } from "vitest";
import { erpReportsApi } from "@/lib/erpReportsAnalyticsBridge";
import { StandardReportBody } from "./ReportPage";
import { extractText, extractHrefs } from "../../test-utils/extractText";

afterEach(() => vi.restoreAllMocks());

describe("StandardReportBody (Sprint 55B) - covers the shared body used by inventory/purchasing/sales/channels/finance/returns-refunds/shipping/warehouse", () => {
  it("renders real metrics and breakdowns (KPI + tabular in one shared body)", async () => {
    vi.spyOn(erpReportsApi, "report").mockResolvedValue({
      metrics: { activeProductCount: 7, expectedInventoryValue: 42.5 },
      breakdowns: [{ dimension: "category", key: "Furniture", label: "Furniture", metrics: [{ key: "count", value: 3 }] }],
      issues: [],
    });
    const el = await StandardReportBody({
      title: "inventory",
      reportType: "inventory",
      searchParams: {},
      mapFn: (r) => ({ metrics: r.metrics, breakdowns: r.breakdowns, warnings: r.issues.map((i: any) => i.message) }),
    });
    const text = extractText(el);
    expect(text).toContain("7");
    expect(text).toContain("€42.50");
    expect(text).toContain("Furniture");
  });

  it("applies filters passed via searchParams and reflects them in the rendered period label", async () => {
    const spy = vi.spyOn(erpReportsApi, "report").mockResolvedValue({ metrics: {}, issues: [] });
    const el = await StandardReportBody({
      title: "sales",
      reportType: "sales",
      searchParams: { period: "ThisMonth", comparisonMode: "PreviousPeriod" },
      mapFn: (r) => ({ metrics: r.metrics }),
    });
    expect(spy).toHaveBeenCalledWith("sales", { period: "ThisMonth", comparisonMode: "PreviousPeriod" });
    const text = extractText(el);
    expect(text).toContain("This month");
    expect(text).toContain("Previous period");
  });

  it("renders an error state without fabricating metrics when the backend request fails", async () => {
    vi.spyOn(erpReportsApi, "report").mockRejectedValue(new Error("ERP authentication failed"));
    const el = await StandardReportBody({ title: "finance", reportType: "finance", searchParams: {}, mapFn: (r) => ({ metrics: r.metrics }) });
    const text = extractText(el);
    expect(text).toContain("Report data is currently unavailable");
    expect(text).toContain("ERP authentication failed");
  });

  it("renders an intentional empty state when breakdowns are empty rather than an empty table", async () => {
    vi.spyOn(erpReportsApi, "report").mockResolvedValue({ metrics: { shipmentCount: 0 }, breakdowns: [], issues: [] });
    const el = await StandardReportBody({ title: "shipping", reportType: "shipping", searchParams: {}, mapFn: (r) => ({ metrics: r.metrics, breakdowns: r.breakdowns }) });
    const text = extractText(el);
    expect(text).toContain("No breakdown data was returned for this period.");
  });

  it("renders export links pointing at the same-origin export proxy for the report type", async () => {
    vi.spyOn(erpReportsApi, "report").mockResolvedValue({ metrics: {}, issues: [] });
    const el = await StandardReportBody({ title: "warehouse", reportType: "warehouse", searchParams: {}, mapFn: (r) => ({ metrics: r.metrics }) });
    const hrefs = extractHrefs(el);
    expect(hrefs).toContain("/api/erp/reports/warehouse/export?format=json");
    expect(hrefs).toContain("/api/erp/reports/warehouse/export?format=csv");
  });
});
