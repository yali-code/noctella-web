// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import * as bridge from "@/lib/stockSyncJobs";
import ConflictsPage from "./page";

afterEach(() => vi.restoreAllMocks());

describe("Stock sync conflicts list page (Sprint 63B)", () => {
  it("renders real rows with a link to the detail page", async () => {
    vi.spyOn(bridge, "listConflicts").mockResolvedValue({ items: [{ id: "c1", channel: "ebay", conflictType: "LocalHigherThanMarketplace", status: "open", localStock: 5, marketplaceStock: 3, detectedAt: "now" }] });
    render(await ConflictsPage());
    expect(screen.getByRole("link", { name: "LocalHigherThanMarketplace" })).toHaveAttribute("href", "/stock-sync/conflicts/c1");
  });

  it("renders an empty state without a raw crash", async () => {
    vi.spyOn(bridge, "listConflicts").mockResolvedValue({ items: [] });
    render(await ConflictsPage());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Stock sync conflicts")).toBeInTheDocument();
  });

  it("renders a graceful error state instead of throwing", async () => {
    vi.spyOn(bridge, "listConflicts").mockRejectedValue(new Error("ERP authentication failed"));
    render(await ConflictsPage());
    expect(await screen.findByRole("alert")).toHaveTextContent("ERP authentication failed");
  });
});
