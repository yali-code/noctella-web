// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as bridge from "@/lib/marketplaceSync";
import ExternalListingsPage from "./page";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

afterEach(() => vi.restoreAllMocks());

describe("External listings page (Sprint 63B)", () => {
  it("renders real rows", async () => {
    vi.spyOn(bridge, "listExternalListings").mockResolvedValue({ items: [{ id: "l1", channel: "ebay", externalStatus: "active", productId: "p1", updatedAt: "now" }] });
    render(await ExternalListingsPage({ searchParams: {} }));
    expect(screen.getByText("ebay")).toBeInTheDocument();
    expect(screen.getByText("Sync now")).toBeInTheDocument();
  });

  it("renders an empty state without a raw crash", async () => {
    vi.spyOn(bridge, "listExternalListings").mockResolvedValue({ items: [] });
    render(await ExternalListingsPage({ searchParams: {} }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("External Listings")).toBeInTheDocument();
  });

  it("renders a graceful error state instead of throwing", async () => {
    vi.spyOn(bridge, "listExternalListings").mockRejectedValue(new Error("ERP authentication failed"));
    render(await ExternalListingsPage({ searchParams: {} }));
    expect(await screen.findByRole("alert")).toHaveTextContent("ERP authentication failed");
  });

  it("syncs a listing and reloads authoritative data on success", async () => {
    const user = userEvent.setup();
    vi.spyOn(bridge, "listExternalListings").mockResolvedValue({ items: [{ id: "l1", channel: "ebay", externalStatus: "active", productId: "p1", updatedAt: "now" }] });
    const syncSpy = vi.spyOn(bridge, "syncExternalListing").mockResolvedValue({} as any);
    render(await ExternalListingsPage({ searchParams: {} }));
    await user.click(screen.getByText("Sync now"));
    await waitFor(() => expect(syncSpy).toHaveBeenCalledWith("l1"));
    expect(refresh).toHaveBeenCalled();
    expect(await screen.findByText("Synced.")).toBeInTheDocument();
  });

  it("prevents a duplicate submission for the same row while syncing", async () => {
    const user = userEvent.setup();
    vi.spyOn(bridge, "listExternalListings").mockResolvedValue({ items: [{ id: "l1", channel: "ebay", externalStatus: "active", productId: "p1", updatedAt: "now" }] });
    let resolveSync!: (v: any) => void;
    const syncSpy = vi.spyOn(bridge, "syncExternalListing").mockReturnValue(new Promise((resolve) => { resolveSync = resolve; }));
    render(await ExternalListingsPage({ searchParams: {} }));
    await user.click(screen.getByText("Sync now"));
    expect(screen.getByText("Syncing…")).toBeDisabled();
    await user.click(screen.getByText("Syncing…"));
    expect(syncSpy).toHaveBeenCalledTimes(1);
    resolveSync({});
  });

  it("shows a graceful error when the sync action fails", async () => {
    const user = userEvent.setup();
    vi.spyOn(bridge, "listExternalListings").mockResolvedValue({ items: [{ id: "l1", channel: "ebay", externalStatus: "active", productId: "p1", updatedAt: "now" }] });
    vi.spyOn(bridge, "syncExternalListing").mockRejectedValue(new Error("Marketplace connection is not connected"));
    render(await ExternalListingsPage({ searchParams: {} }));
    await user.click(screen.getByText("Sync now"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Marketplace connection is not connected");
  });
});
