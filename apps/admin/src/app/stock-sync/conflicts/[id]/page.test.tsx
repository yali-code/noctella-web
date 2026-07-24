// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as bridge from "@/lib/stockSyncJobs";
import ConflictDetail from "./page";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

afterEach(() => vi.restoreAllMocks());

const baseConflict = (overrides: any = {}) => ({ id: "c1", channel: "ebay", conflictType: "LocalHigherThanMarketplace", status: "open", localStock: 5, marketplaceStock: 3, detectedAt: "now", ...overrides });

describe("Stock sync conflict detail page (Sprint 63B)", () => {
  it("renders real conflict data", async () => {
    vi.spyOn(bridge, "getConflict").mockResolvedValue(baseConflict());
    render(await ConflictDetail({ params: { id: "c1" } }));
    expect(screen.getByText("Conflict c1")).toBeInTheDocument();
  });

  it("renders a graceful error state instead of throwing", async () => {
    vi.spyOn(bridge, "getConflict").mockRejectedValue(new Error("Conflict not found"));
    render(await ConflictDetail({ params: { id: "missing" } }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Conflict not found");
  });

  it("hides all resolution actions once the conflict is no longer open", async () => {
    vi.spyOn(bridge, "getConflict").mockResolvedValue(baseConflict({ status: "resolved" }));
    render(await ConflictDetail({ params: { id: "c1" } }));
    expect(screen.queryByText("Mark Resolved")).not.toBeInTheDocument();
    expect(screen.queryByText("Ignore")).not.toBeInTheDocument();
    expect(screen.queryByText("Retry to Marketplace")).not.toBeInTheDocument();
  });

  it("sends only the fixed MarkResolved action value, after explicit confirmation", async () => {
    const user = userEvent.setup();
    vi.spyOn(bridge, "getConflict").mockResolvedValue(baseConflict());
    const resolveSpy = vi.spyOn(bridge, "resolveConflict").mockResolvedValue({} as any);
    render(await ConflictDetail({ params: { id: "c1" } }));
    await user.click(screen.getByText("Mark Resolved"));
    expect(resolveSpy).not.toHaveBeenCalled();
    await user.click(screen.getByText("Confirm Mark Resolved"));
    await waitFor(() => expect(resolveSpy).toHaveBeenCalledWith("c1", "MarkResolved"));
    expect(refresh).toHaveBeenCalled();
  });

  it("sends only the fixed Ignore action value, after explicit confirmation", async () => {
    const user = userEvent.setup();
    vi.spyOn(bridge, "getConflict").mockResolvedValue(baseConflict());
    const resolveSpy = vi.spyOn(bridge, "resolveConflict").mockResolvedValue({} as any);
    render(await ConflictDetail({ params: { id: "c1" } }));
    await user.click(screen.getByText("Ignore"));
    expect(resolveSpy).not.toHaveBeenCalled();
    await user.click(screen.getByText("Confirm Ignore"));
    await waitFor(() => expect(resolveSpy).toHaveBeenCalledWith("c1", "Ignore"));
    expect(refresh).toHaveBeenCalled();
  });

  it("sends the fixed RetryLocalToMarketplace action without requiring confirmation", async () => {
    const user = userEvent.setup();
    vi.spyOn(bridge, "getConflict").mockResolvedValue(baseConflict());
    const resolveSpy = vi.spyOn(bridge, "resolveConflict").mockResolvedValue({} as any);
    render(await ConflictDetail({ params: { id: "c1" } }));
    await user.click(screen.getByText("Retry to Marketplace"));
    await waitFor(() => expect(resolveSpy).toHaveBeenCalledWith("c1", "RetryLocalToMarketplace"));
    expect(refresh).toHaveBeenCalled();
  });

  it("shows a loading state on Retry to Marketplace and prevents duplicate submission", async () => {
    const user = userEvent.setup();
    vi.spyOn(bridge, "getConflict").mockResolvedValue(baseConflict());
    let resolvePromise!: (v: any) => void;
    const resolveSpy = vi.spyOn(bridge, "resolveConflict").mockReturnValue(new Promise((resolve) => { resolvePromise = resolve; }));
    render(await ConflictDetail({ params: { id: "c1" } }));
    await user.click(screen.getByText("Retry to Marketplace"));
    expect(screen.getByText("Retrying…")).toBeDisabled();
    await user.click(screen.getByText("Retrying…"));
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    resolvePromise({});
  });

  it("shows the backend's structured error message on failure", async () => {
    const user = userEvent.setup();
    vi.spyOn(bridge, "getConflict").mockResolvedValue(baseConflict());
    vi.spyOn(bridge, "resolveConflict").mockRejectedValue(new Error("Conflict already resolved"));
    render(await ConflictDetail({ params: { id: "c1" } }));
    await user.click(screen.getByText("Retry to Marketplace"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Conflict already resolved");
  });
});
