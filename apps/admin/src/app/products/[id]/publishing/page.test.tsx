// @vitest-environment jsdom
// Sprint 146: this file replaces the previous Sprint 107/140/141 suite in full - every test in the
// old suite exercised functionality (Marketplace Preparation editing, canonical Price editing,
// Marketing Tags editing, unified channel selection + Publish Selected) that has now moved into
// the canonical Product Edit workspace and been removed from this page. Nothing from the old
// suite could be preserved unchanged since the page's entire prior subject matter is gone; this
// suite instead proves the new Publication Operations / History surface: the superseded sections
// are genuinely absent, and Connection status / External Listings / Publish History (with Retry)
// remain functional.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PublishChannel, PublishJobStatus } from "@noctella/shared";
import * as marketplacesLib from "@/lib/marketplaces";
import ProductPublishingPage from "./page";

afterEach(() => vi.restoreAllMocks());

function mockLoads(overrides: { connections?: unknown[]; jobs?: unknown[]; listings?: unknown[] } = {}) {
  vi.spyOn(marketplacesLib.marketplaceApi, "listConnections").mockResolvedValue((overrides.connections ?? []) as any);
  vi.spyOn(marketplacesLib.marketplaceApi, "listJobs").mockResolvedValue((overrides.jobs ?? []) as any);
  vi.spyOn(marketplacesLib.marketplaceApi, "externalListings").mockResolvedValue((overrides.listings ?? []) as any);
}

describe("ProductPublishingPage - Sprint 146 Publication Operations / History", () => {
  it("renders as an Operations/History surface and links to the canonical Edit workspace", async () => {
    mockLoads();
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    expect(await screen.findByText("Publication Operations / History")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Edit Product" });
    expect(link).toHaveAttribute("href", "/products/product-1/edit");
  });

  it("the old 'Publish to Multiple Channels' initiation UI (channel checkboxes + Publish Selected) is gone", async () => {
    mockLoads();
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    await screen.findByText("Publication Operations / History");
    expect(screen.queryByRole("button", { name: "Publish Selected" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "eBay" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Etsy" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Noctella Web" })).not.toBeInTheDocument();
  });

  it("the old single-channel Execute Publish button is gone", async () => {
    mockLoads();
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    await screen.findByText("Publication Operations / History");
    expect(screen.queryByRole("button", { name: "Execute Publish" })).not.toBeInTheDocument();
  });

  it("the old Marketplace Preparation Generate/Regenerate/Approve editing UI is gone", async () => {
    mockLoads();
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    await screen.findByText("Publication Operations / History");
    expect(screen.queryByRole("button", { name: "Prepare with AI" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Regenerate with AI" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve Marketplace Preparation" })).not.toBeInTheDocument();
  });

  it("the old canonical Price editor is gone", async () => {
    mockLoads();
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    await screen.findByText("Publication Operations / History");
    expect(screen.queryByRole("button", { name: "Save Price" })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("No price set")).not.toBeInTheDocument();
  });

  it("the old Marketing Tags editor is gone", async () => {
    mockLoads();
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    await screen.findByText("Publication Operations / History");
    expect(screen.queryByRole("button", { name: "Add Tag" })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("e.g. Father's Day")).not.toBeInTheDocument();
  });

  it("no Product-editing form exists on this page", async () => {
    mockLoads();
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    await screen.findByText("Publication Operations / History");
    expect(screen.queryByLabelText(/sku/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/stock quantity/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^status$/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save Changes" })).not.toBeInTheDocument();
  });

  it("connection status remains available for the selected channel", async () => {
    mockLoads({
      connections: [{ id: "c1", channel: PublishChannel.Ebay, accountLabel: "Default", status: "connected", tokenExpiresAt: "2026-06-01T00:00:00.000Z", createdAt: "t", updatedAt: "t" }],
    });
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    expect(await screen.findByText("Status: connected")).toBeInTheDocument();
    expect(screen.getByText("Expiry: 2026-06-01T00:00:00.000Z")).toBeInTheDocument();
  });

  it("Noctella Web is shown as requiring no external connection", async () => {
    const user = userEvent.setup();
    mockLoads();
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    await user.selectOptions(await screen.findByRole("combobox"), "noctella_web");
    expect(await screen.findByText("Direct channel — no external connection required.")).toBeInTheDocument();
  });

  it("External Listings remain, rendered per listing", async () => {
    mockLoads({
      listings: [{ id: "ext-1", channel: PublishChannel.Ebay, externalListingId: "EBAY-123", externalListingUrl: "https://ebay.test/123", externalStatus: "active" }],
    });
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    expect(await screen.findByText("EBAY-123")).toBeInTheDocument();
  });

  it("Publish History remains, and Retry remains available and functional for a retryable job", async () => {
    const user = userEvent.setup();
    mockLoads({
      jobs: [{ id: "job-1", productId: "product-1", channel: PublishChannel.Ebay, status: PublishJobStatus.RetryPending, attemptCount: 1, idempotencyKey: "k", payloadSnapshot: {}, createdAt: "t", updatedAt: "t" }],
    });
    const retrySpy = vi.spyOn(marketplacesLib.marketplaceApi, "retry").mockResolvedValue({} as any);
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    const retryButton = await screen.findByRole("button", { name: "Retry" });
    await user.click(retryButton);
    await waitFor(() => expect(retrySpy).toHaveBeenCalledWith("job-1"));
  });

  it("Retry is not offered once a job has exhausted its retry allowance (existing canRetry behavior unchanged)", async () => {
    mockLoads({
      jobs: [{ id: "job-1", productId: "product-1", channel: PublishChannel.Ebay, status: PublishJobStatus.RetryPending, attemptCount: 3, idempotencyKey: "k", payloadSnapshot: {}, createdAt: "t", updatedAt: "t" }],
    });
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    await screen.findByText("Publication Operations / History");
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });
});
