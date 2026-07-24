// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import * as bridge from "@/lib/stockSyncJobs";
import BackgroundJobsPage from "./page";

afterEach(() => vi.restoreAllMocks());

describe("Background jobs list page (Sprint 63B)", () => {
  it("renders real rows", async () => {
    vi.spyOn(bridge, "listBackgroundJobs").mockResolvedValue({ items: [{ id: "job-1", type: "stock_sync_listing", status: "failed", attemptCount: 1, maxAttempts: 5, runAfter: "now" }] });
    render(await BackgroundJobsPage());
    expect(screen.getByText("job-1")).toBeInTheDocument();
  });

  it("renders an empty state without a raw crash", async () => {
    vi.spyOn(bridge, "listBackgroundJobs").mockResolvedValue({ items: [] });
    render(await BackgroundJobsPage());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Background jobs")).toBeInTheDocument();
  });

  it("renders a graceful error state instead of throwing", async () => {
    vi.spyOn(bridge, "listBackgroundJobs").mockRejectedValue(new Error("ERP authentication failed"));
    render(await BackgroundJobsPage());
    expect(await screen.findByRole("alert")).toHaveTextContent("ERP authentication failed");
  });
});
