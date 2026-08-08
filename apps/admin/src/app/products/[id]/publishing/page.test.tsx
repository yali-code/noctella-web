// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PublishChannel } from "@noctella/shared";
import { ApiError } from "@/lib/api";
import * as publishingLib from "@/lib/publishing";
import * as marketplacesLib from "@/lib/marketplaces";
import ProductPublishingPage from "./page";

afterEach(() => vi.restoreAllMocks());

function preparation(overrides: Record<string, unknown> = {}) {
  return {
    id: "prep-1",
    productId: "product-1",
    channel: PublishChannel.Ebay,
    status: "pending",
    baseProductUpdatedAt: "2026-01-01T00:00:00.000Z",
    suggestedTitle: "Suggested eBay Title",
    suggestedDescription: "Suggested eBay Description",
    providerName: "mock-marketplace-prep-v1",
    promptVersion: "sprint107-v1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function mockBaseLoads() {
  vi.spyOn(publishingLib.publishingApi, "getPreview").mockResolvedValue({
    productId: "product-1",
    channel: PublishChannel.Ebay,
    validation: { productId: "product-1", channel: PublishChannel.Ebay, valid: false, errors: [], warnings: [] },
  } as any);
  vi.spyOn(marketplacesLib.marketplaceApi, "listConnections").mockResolvedValue([]);
  vi.spyOn(marketplacesLib.marketplaceApi, "listJobs").mockResolvedValue([]);
  vi.spyOn(marketplacesLib.marketplaceApi, "externalListings").mockResolvedValue([]);
}

describe("ProductPublishingPage - Marketplace Preparation (Sprint 107)", () => {
  it("shows 'no preparation yet' and a Prepare with AI button when none exists", async () => {
    mockBaseLoads();
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockRejectedValue(new ApiError("Not found", 404));
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    await screen.findByText(/No marketplace preparation exists yet/);
    expect(screen.getByRole("button", { name: "Prepare with AI" })).toBeInTheDocument();
  });

  it("generates a preparation and pre-fills editable fields from the AI suggestion", async () => {
    const user = userEvent.setup();
    mockBaseLoads();
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockRejectedValue(new ApiError("Not found", 404));
    const generateSpy = vi.spyOn(publishingLib.marketplacePreparationApi, "generate").mockResolvedValue(preparation() as any);
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    await screen.findByRole("button", { name: "Prepare with AI" });
    await user.click(screen.getByRole("button", { name: "Prepare with AI" }));
    await waitFor(() => expect(generateSpy).toHaveBeenCalledWith("product-1", PublishChannel.Ebay));
    expect(await screen.findByDisplayValue("Suggested eBay Title")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Suggested eBay Description")).toBeInTheDocument();
  });

  it("admin can edit a suggested value before approving, and the edited value (not the raw suggestion) is submitted", async () => {
    const user = userEvent.setup();
    mockBaseLoads();
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockResolvedValue(preparation() as any);
    const approveSpy = vi.spyOn(publishingLib.marketplacePreparationApi, "approve").mockResolvedValue({} as any);
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    const titleInput = await screen.findByDisplayValue("Suggested eBay Title");
    await user.clear(titleInput);
    await user.type(titleInput, "Admin Edited Title");
    await user.click(screen.getByRole("button", { name: "Approve Marketplace Preparation" }));
    await waitFor(() =>
      expect(approveSpy).toHaveBeenCalledWith(
        "product-1",
        expect.objectContaining({ channel: PublishChannel.Ebay, expectedProposalUpdatedAt: "2026-01-01T00:00:00.000Z", title: "Admin Edited Title" }),
      ),
    );
  });

  it("shows a stale/conflict error without crashing when approval is rejected", async () => {
    mockBaseLoads();
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockResolvedValue(preparation() as any);
    vi.spyOn(publishingLib.marketplacePreparationApi, "approve").mockRejectedValue(
      new ApiError("This marketplace preparation changed since you loaded it. Reload it and try again.", 409, undefined, "MARKETPLACE_PREPARATION_VERSION_CONFLICT"),
    );
    const user = userEvent.setup();
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    await screen.findByDisplayValue("Suggested eBay Title");
    await user.click(screen.getByRole("button", { name: "Approve Marketplace Preparation" }));
    await screen.findByText("This marketplace preparation changed since you loaded it. Reload it and try again.");
  });

  it("Approve never calls Execute Publish - the two actions remain fully separate", async () => {
    mockBaseLoads();
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockResolvedValue(preparation() as any);
    vi.spyOn(publishingLib.marketplacePreparationApi, "approve").mockResolvedValue({} as any);
    const executeSpy = vi.spyOn(marketplacesLib.marketplaceApi, "executePublish");
    const user = userEvent.setup();
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    await screen.findByDisplayValue("Suggested eBay Title");
    await user.click(screen.getByRole("button", { name: "Approve Marketplace Preparation" }));
    await waitFor(() => expect(publishingLib.marketplacePreparationApi.approve).toHaveBeenCalled());
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("Approve button is disabled once status is Applied, requiring a fresh Regenerate", async () => {
    mockBaseLoads();
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockResolvedValue(preparation({ status: "applied" }) as any);
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    await screen.findByDisplayValue("Suggested eBay Title");
    expect(screen.getByRole("button", { name: "Approve Marketplace Preparation" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Regenerate with AI" })).toBeInTheDocument();
  });

  it("existing Execute Publish button/gating is unchanged and independent of Marketplace Preparation state", async () => {
    vi.spyOn(publishingLib.publishingApi, "getPreview").mockResolvedValue({
      productId: "product-1",
      channel: PublishChannel.Ebay,
      validation: { productId: "product-1", channel: PublishChannel.Ebay, valid: true, errors: [], warnings: [] },
      payload: { productId: "product-1", channel: PublishChannel.Ebay, listingStatus: "draft", title: "x", description: "y", priceEur: 10, images: [], metadata: {} },
    } as any);
    vi.spyOn(marketplacesLib.marketplaceApi, "listConnections").mockResolvedValue([{ id: "c1", channel: PublishChannel.Ebay, accountLabel: "Default", status: "connected", createdAt: "t", updatedAt: "t" }] as any);
    vi.spyOn(marketplacesLib.marketplaceApi, "listJobs").mockResolvedValue([]);
    vi.spyOn(marketplacesLib.marketplaceApi, "externalListings").mockResolvedValue([]);
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockRejectedValue(new ApiError("Not found", 404));
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    const executeButton = await screen.findByRole("button", { name: "Execute Publish" });
    expect(executeButton).not.toBeDisabled();
  });

  it("Sprint 109/112: renders an Edit Product link pointing to /products/<id>/edit when the preview loads normally", async () => {
    mockBaseLoads();
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockRejectedValue(new ApiError("Not found", 404));
    render(<ProductPublishingPage params={{ id: "product-1" }} />);

    const link = await screen.findByRole("link", { name: "Edit Product" });
    expect(link).toHaveAttribute("href", "/products/product-1/edit");
  });

  it("Sprint 112: Edit Product still renders when the publish preview fails to load", async () => {
    const getPreviewSpy = vi.spyOn(publishingLib.publishingApi, "getPreview").mockRejectedValue(new Error("Failed to load publishing preview"));
    vi.spyOn(marketplacesLib.marketplaceApi, "listConnections").mockResolvedValue([]);
    vi.spyOn(marketplacesLib.marketplaceApi, "listJobs").mockResolvedValue([]);
    vi.spyOn(marketplacesLib.marketplaceApi, "externalListings").mockResolvedValue([]);
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockRejectedValue(new ApiError("Not found", 404));
    render(<ProductPublishingPage params={{ id: "product-1" }} />);

    // Sprint 112: the Edit Product link renders unconditionally, before any async load even
    // settles - confirm the preview call genuinely failed (proving this is the failure path, not
    // merely a slow success), then confirm Edit Product survives it. Its own error text is rendered
    // through the existing safeError() redaction (unrelated, pre-existing, not asserted here).
    await waitFor(() => expect(getPreviewSpy).toHaveBeenCalled());
    const link = screen.getByRole("link", { name: "Edit Product" });
    expect(link).toHaveAttribute("href", "/products/product-1/edit");
    expect(screen.queryByRole("button", { name: "Execute Publish" })).not.toBeInTheDocument();
  });
});
