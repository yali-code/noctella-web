import { describe, expect, it, vi, afterEach } from "vitest";
import { erpReportsApi } from "@/lib/erpReportsAnalyticsBridge";
import DashboardPage from "./page";
import { extractText } from "../test-utils/extractText";

afterEach(() => vi.restoreAllMocks());

describe("Dashboard homepage (Sprint 55B)", () => {
  it("renders real fetched values, not the old static placeholders", async () => {
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
    vi.spyOn(erpReportsApi, "dashboard").mockRejectedValue(new Error("Report range is too large"));
    const text = extractText(await DashboardPage());
    expect(text).toContain("Report data is currently unavailable");
    expect(text).toContain("Report range is too large");
  });

  it("renders explicit 'Incomplete' rather than a fabricated zero for a missing metric", async () => {
    vi.spyOn(erpReportsApi, "dashboard").mockResolvedValue({ inventory: {}, sales: {}, warehouse: {}, customers: {}, issues: [] });
    const text = extractText(await DashboardPage());
    expect(text).toContain("Incomplete");
  });

  it("formats EUR values with a euro sign and two decimal places", async () => {
    vi.spyOn(erpReportsApi, "dashboard").mockResolvedValue({ inventory: { expectedInventoryValue: 5 }, sales: {}, warehouse: {}, customers: {}, issues: [] });
    const text = extractText(await DashboardPage());
    expect(text).toContain("€5.00");
  });
});
