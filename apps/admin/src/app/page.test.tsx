import { describe, expect, it, vi, afterEach } from "vitest";
import { erpReportsApi } from "@/lib/erpReportsAnalyticsBridge";
import * as apiLib from "@/lib/api";
import DashboardPage from "./page";
import { extractText, extractHrefs } from "../test-utils/extractText";

afterEach(() => vi.restoreAllMocks());

// Sprint 136/139: every existing test below exercises only the ERP reports bridge and never
// asserted on the Pending Publish card, so it has no fixed count expectation - mock the
// pending-publish call it now also triggers so it resolves deterministically instead of hitting a
// real network call, without changing any existing assertion.
function mockReadyToPublishCount(total = 3) {
  return vi.spyOn(apiLib.api, "get").mockResolvedValue({ items: [], total, page: 1, pageSize: 1 });
}

describe("Dashboard homepage (Sprint 55B)", () => {
  it("renders real fetched values, not the old static placeholders", async () => {
    mockReadyToPublishCount();
    vi.spyOn(erpReportsApi, "dashboard").mockResolvedValue({
      inventory: { activeProductCount: 12, physicalStockQuantity: 40, expectedInventoryValue: 1234.5 },
      sales: { orderCount: 6, grossRevenue: 987.65 },
      warehouse: { activeReservations: 2 },
      customers: { customerCount: 9 },
      issues: [],
    });
    const text = extractText(await DashboardPage());
    expect(text).toContain("12");
    expect(text).toContain("40");
    expect(text).toContain("€1234.50");
    expect(text).toContain("€987.65");
    expect(text).not.toMatch(/^—$/m);
  });

  it("renders an error state when the dashboard request fails, without fabricating zero values", async () => {
    mockReadyToPublishCount();
    vi.spyOn(erpReportsApi, "dashboard").mockRejectedValue(new Error("Report range is too large"));
    const text = extractText(await DashboardPage());
    expect(text).toContain("Report data is currently unavailable");
    expect(text).toContain("Report range is too large");
  });

  it("renders explicit 'Incomplete' rather than a fabricated zero for a missing metric", async () => {
    mockReadyToPublishCount();
    vi.spyOn(erpReportsApi, "dashboard").mockResolvedValue({ inventory: {}, sales: {}, warehouse: {}, customers: {}, issues: [] });
    const text = extractText(await DashboardPage());
    expect(text).toContain("Incomplete");
  });

  it("formats EUR values with a euro sign and two decimal places", async () => {
    mockReadyToPublishCount();
    vi.spyOn(erpReportsApi, "dashboard").mockResolvedValue({ inventory: { expectedInventoryValue: 5 }, sales: {}, warehouse: {}, customers: {}, issues: [] });
    const text = extractText(await DashboardPage());
    expect(text).toContain("€5.00");
  });
});

describe("Dashboard Pending Publish card (Sprint 136, relabeled and repointed in Sprint 139)", () => {
  it("uses the total from the Pending Publish read model - the same eligibility the queue page itself queries", async () => {
    const getSpy = mockReadyToPublishCount(7);
    vi.spyOn(erpReportsApi, "dashboard").mockResolvedValue({ inventory: {}, sales: {}, warehouse: {}, customers: {}, issues: [] });
    const text = extractText(await DashboardPage());
    expect(getSpy).toHaveBeenCalledWith("/api/products/pending-publish?pageSize=1");
    expect(text).toContain("Pending Publish");
    expect(text).toContain("7");
  });

  it("card navigates to /ready-to-publish", async () => {
    mockReadyToPublishCount(7);
    vi.spyOn(erpReportsApi, "dashboard").mockResolvedValue({ inventory: {}, sales: {}, warehouse: {}, customers: {}, issues: [] });
    const hrefs = extractHrefs(await DashboardPage());
    expect(hrefs).toContain("/ready-to-publish");
  });

  it("existing Dashboard cards remain intact alongside the new card", async () => {
    mockReadyToPublishCount(7);
    vi.spyOn(erpReportsApi, "dashboard").mockResolvedValue({
      inventory: { activeProductCount: 12 },
      sales: {},
      warehouse: {},
      customers: {},
      issues: [],
    });
    const text = extractText(await DashboardPage());
    expect(text).toContain("Active Products");
    expect(text).toContain("12");
    expect(text).toContain("Pending Publish");
    expect(text).toContain("7");
  });

  it("a Ready to Publish count failure does not hide the rest of the Dashboard", async () => {
    vi.spyOn(apiLib.api, "get").mockRejectedValue(new Error("Ready to Publish count unavailable"));
    vi.spyOn(erpReportsApi, "dashboard").mockResolvedValue({
      inventory: { activeProductCount: 12 },
      sales: {},
      warehouse: {},
      customers: {},
      issues: [],
    });
    const text = extractText(await DashboardPage());
    expect(text).toContain("Active Products");
    expect(text).toContain("12");
  });

  it("an ERP dashboard failure does not hide the Ready to Publish card", async () => {
    mockReadyToPublishCount(7);
    vi.spyOn(erpReportsApi, "dashboard").mockRejectedValue(new Error("Report range is too large"));
    const text = extractText(await DashboardPage());
    expect(text).toContain("Pending Publish");
    expect(text).toContain("7");
  });
});
