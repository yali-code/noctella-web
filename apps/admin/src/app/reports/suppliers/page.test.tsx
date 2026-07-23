import { describe, expect, it, vi, afterEach } from "vitest";
import { erpReportsApi } from "@/lib/erpReportsAnalyticsBridge";
import SuppliersReportPage from "./page";
import { extractText } from "../../../test-utils/extractText";

afterEach(() => vi.restoreAllMocks());

describe("Suppliers report page (Sprint 55B) - bespoke tabular page (list shape, not metrics)", () => {
  it("renders a real supplier table from the backend response", async () => {
    vi.spyOn(erpReportsApi, "report").mockResolvedValue({
      suppliers: [{ id: "s1", maskedName: "Au***on House", purchaseCount: 4, totalSpend: 512.3, averageLandedCost: 128.08 }],
      issues: [],
    });
    const text = extractText(await SuppliersReportPage({ searchParams: {} }));
    expect(text).toContain("Au***on House");
    expect(text).toContain("4");
    expect(text).toContain("€512.30");
  });

  it("renders an intentional empty state when no suppliers are returned", async () => {
    vi.spyOn(erpReportsApi, "report").mockResolvedValue({ suppliers: [], issues: [] });
    const text = extractText(await SuppliersReportPage({ searchParams: {} }));
    expect(text).toContain("No suppliers were returned for this period.");
  });
});
