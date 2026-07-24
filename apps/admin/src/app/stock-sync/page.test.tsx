// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as bridge from "@/lib/stockSyncJobs";
import StockSyncPage from "./page";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

afterEach(() => vi.restoreAllMocks());

function mockStatus() {
  vi.spyOn(bridge, "getStockSyncStatus").mockResolvedValue({ lastRun: "2026-01-01", nextRun: "2026-01-02", jobs: { pending: 1 } });
  vi.spyOn(bridge, "stockSyncAudit").mockResolvedValue({ items: [{ id: "a1", channel: "ebay", externalListingId: "l1", resultStatus: "ok", requestedMarketplaceStock: 2 }] });
}

describe("Stock sync overview page (Sprint 63B)", () => {
  it("renders the real summary", async () => {
    mockStatus();
    render(await StockSyncPage());
    expect(screen.getByText(/Last run: 2026-01-01/)).toBeInTheDocument();
  });

  it("renders a graceful error state instead of throwing", async () => {
    vi.spyOn(bridge, "getStockSyncStatus").mockRejectedValue(new Error("ERP authentication failed"));
    vi.spyOn(bridge, "stockSyncAudit").mockResolvedValue({ items: [] });
    render(await StockSyncPage());
    expect(await screen.findByRole("alert")).toHaveTextContent("ERP authentication failed");
  });

  it("triggers a fixed-channel sync and reloads authoritative data on success", async () => {
    const user = userEvent.setup();
    mockStatus();
    const syncSpy = vi.spyOn(bridge, "syncChannel").mockResolvedValue({} as any);
    render(await StockSyncPage());
    await user.click(screen.getByText("Sync eBay"));
    await waitFor(() => expect(syncSpy).toHaveBeenCalledWith("ebay"));
    expect(refresh).toHaveBeenCalled();
    expect(await screen.findByText("Sync triggered.")).toBeInTheDocument();
  });

  it("triggers an all-channel sync and reloads authoritative data on success", async () => {
    const user = userEvent.setup();
    mockStatus();
    const syncAllSpy = vi.spyOn(bridge, "syncAllChannels").mockResolvedValue({} as any);
    render(await StockSyncPage());
    await user.click(screen.getByText("Sync all channels"));
    await waitFor(() => expect(syncAllSpy).toHaveBeenCalled());
    expect(refresh).toHaveBeenCalled();
  });

  it("shows a loading state and prevents duplicate submission across triggers", async () => {
    const user = userEvent.setup();
    mockStatus();
    let resolveSync!: (v: any) => void;
    const syncSpy = vi.spyOn(bridge, "syncChannel").mockReturnValue(new Promise((resolve) => { resolveSync = resolve; }));
    render(await StockSyncPage());
    await user.click(screen.getByText("Sync eBay"));
    expect(screen.getByText("Syncing…")).toBeDisabled();
    expect(screen.getByText("Sync all channels")).toBeDisabled();
    await user.click(screen.getByText("Sync all channels"));
    expect(syncSpy).toHaveBeenCalledTimes(1);
    resolveSync({});
  });

  it("shows a structured error when a trigger fails", async () => {
    const user = userEvent.setup();
    mockStatus();
    vi.spyOn(bridge, "syncChannel").mockRejectedValue(new Error("Marketplace connection is not connected"));
    render(await StockSyncPage());
    await user.click(screen.getByText("Sync eBay"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Marketplace connection is not connected");
  });
});
