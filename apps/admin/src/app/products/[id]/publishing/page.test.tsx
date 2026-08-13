// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PublishChannel } from "@noctella/shared";
import { ApiError } from "@/lib/api";
import * as apiLib from "@/lib/api";
import * as publishingLib from "@/lib/publishing";
import * as marketplacesLib from "@/lib/marketplaces";
import * as marketingTagsLib from "@/lib/marketingTags";
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

/** Sprint 140: minimal ProductDetail fixture - only priceEur/updatedAt are actually read by this page's new price editor. */
function product(overrides: Record<string, unknown> = {}) {
  return {
    id: "product-1",
    sku: "NOC-000001",
    title: "Test Product",
    status: "draft",
    priceEur: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    photos: [],
    images: [],
    marketplaceReadiness: {},
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
  // Sprint 140: the page's new direct Product fetch (price editor) and Marketing Tags list -
  // every pre-existing test in this file exercises the Marketplace Preparation section only, so a
  // safe, unasserted default (no price, no tags) keeps them unaffected by this addition.
  vi.spyOn(apiLib.api, "get").mockImplementation((path: string) => {
    if (path === "/api/products/product-1") return Promise.resolve(product()) as any;
    return Promise.reject(new Error(`Unexpected path: ${path}`));
  });
  vi.spyOn(marketingTagsLib.marketingTagsApi, "list").mockResolvedValue([]);
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
    vi.spyOn(apiLib.api, "get").mockImplementation((path: string) => {
      if (path === "/api/products/product-1") return Promise.resolve(product()) as any;
      return Promise.reject(new Error(`Unexpected path: ${path}`));
    });
    vi.spyOn(marketingTagsLib.marketingTagsApi, "list").mockResolvedValue([]);
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
    vi.spyOn(apiLib.api, "get").mockImplementation((path: string) => {
      if (path === "/api/products/product-1") return Promise.resolve(product()) as any;
      return Promise.reject(new Error(`Unexpected path: ${path}`));
    });
    vi.spyOn(marketingTagsLib.marketingTagsApi, "list").mockResolvedValue([]);
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

/**
 * Sprint 140: canonical price editor - deliberately channel-agnostic, independent of Marketplace
 * Preparation Approve above, reusing the existing PUT /api/products/:id endpoint with a minimal
 * partial body and optimistic concurrency.
 */
describe("ProductPublishingPage - Price (Sprint 140)", () => {
  it("displays the current canonical price", async () => {
    mockBaseLoads();
    vi.spyOn(apiLib.api, "get").mockImplementation((path: string) => {
      if (path === "/api/products/product-1") return Promise.resolve(product({ priceEur: 149.99 })) as any;
      return Promise.reject(new Error(`Unexpected path: ${path}`));
    });
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockRejectedValue(new ApiError("Not found", 404));
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    expect(await screen.findByDisplayValue("149.99")).toBeInTheDocument();
  });

  it("Save Price sends priceEur and the current expectedUpdatedAt through the existing PUT path", async () => {
    const user = userEvent.setup();
    mockBaseLoads();
    vi.spyOn(apiLib.api, "get").mockImplementation((path: string) => {
      if (path === "/api/products/product-1") return Promise.resolve(product({ priceEur: null, updatedAt: "2026-02-01T00:00:00.000Z" })) as any;
      return Promise.reject(new Error(`Unexpected path: ${path}`));
    });
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockRejectedValue(new ApiError("Not found", 404));
    const putSpy = vi.spyOn(apiLib.api, "put").mockResolvedValue(product({ priceEur: 250, updatedAt: "2026-02-02T00:00:00.000Z" }) as any);
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    const priceInput = await screen.findByPlaceholderText("No price set");
    await user.type(priceInput, "250");
    await user.click(screen.getByRole("button", { name: "Save Price" }));
    await waitFor(() =>
      expect(putSpy).toHaveBeenCalledWith("/api/products/product-1", { priceEur: 250, expectedUpdatedAt: "2026-02-01T00:00:00.000Z" }),
    );
  });

  it("clearing the price input and saving sends priceEur: null (preserves the existing clear-to-null contract)", async () => {
    const user = userEvent.setup();
    mockBaseLoads();
    vi.spyOn(apiLib.api, "get").mockImplementation((path: string) => {
      if (path === "/api/products/product-1") return Promise.resolve(product({ priceEur: 100 })) as any;
      return Promise.reject(new Error(`Unexpected path: ${path}`));
    });
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockRejectedValue(new ApiError("Not found", 404));
    const putSpy = vi.spyOn(apiLib.api, "put").mockResolvedValue(product({ priceEur: null }) as any);
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    const priceInput = await screen.findByDisplayValue("100");
    await user.clear(priceInput);
    await user.click(screen.getByRole("button", { name: "Save Price" }));
    await waitFor(() => expect(putSpy).toHaveBeenCalledWith("/api/products/product-1", expect.objectContaining({ priceEur: null })));
  });

  it("refreshes the version token after a successful save, so the next save uses the new updatedAt", async () => {
    const user = userEvent.setup();
    mockBaseLoads();
    vi.spyOn(apiLib.api, "get").mockImplementation((path: string) => {
      if (path === "/api/products/product-1") return Promise.resolve(product({ priceEur: null, updatedAt: "2026-02-01T00:00:00.000Z" })) as any;
      return Promise.reject(new Error(`Unexpected path: ${path}`));
    });
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockRejectedValue(new ApiError("Not found", 404));
    const putSpy = vi.spyOn(apiLib.api, "put").mockResolvedValue(product({ priceEur: 80, updatedAt: "2026-02-05T00:00:00.000Z" }) as any);
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    const priceInput = await screen.findByPlaceholderText("No price set");
    await user.type(priceInput, "80");
    await user.click(screen.getByRole("button", { name: "Save Price" }));
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(1));

    await user.clear(await screen.findByDisplayValue("80"));
    await user.type(screen.getByPlaceholderText("No price set"), "90");
    await user.click(screen.getByRole("button", { name: "Save Price" }));
    await waitFor(() =>
      expect(putSpy).toHaveBeenLastCalledWith("/api/products/product-1", { priceEur: 90, expectedUpdatedAt: "2026-02-05T00:00:00.000Z" }),
    );
  });

  it("shows a save error without crashing (e.g. a stale version conflict)", async () => {
    const user = userEvent.setup();
    mockBaseLoads();
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockRejectedValue(new ApiError("Not found", 404));
    vi.spyOn(apiLib.api, "put").mockRejectedValue(new ApiError("This product changed since you loaded it.", 409));
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    const priceInput = await screen.findByPlaceholderText("No price set");
    await user.type(priceInput, "10");
    await user.click(screen.getByRole("button", { name: "Save Price" }));
    await screen.findByText("This product changed since you loaded it.");
  });

  it("does not introduce SKU, Inventory quantity, or status editing controls", async () => {
    mockBaseLoads();
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockRejectedValue(new ApiError("Not found", 404));
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    await screen.findByRole("button", { name: "Save Price" });
    expect(screen.queryByDisplayValue("NOC-000001")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/sku/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/stock quantity/i)).not.toBeInTheDocument();
  });
});

/**
 * Sprint 140: Product Marketing Tags - a distinct concept from Product Category, SEO keywords,
 * and the per-channel Etsy tags edited above. Explicit add/remove only, no replace-all.
 */
describe("ProductPublishingPage - Marketing Tags (Sprint 140)", () => {
  it("lists the Product's current Marketing Tags", async () => {
    mockBaseLoads();
    vi.spyOn(marketingTagsLib.marketingTagsApi, "list").mockResolvedValue([
      { id: "tag-1", key: "fathers-day", label: "Father's Day", createdAt: "t", updatedAt: "t" },
    ] as any);
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockRejectedValue(new ApiError("Not found", 404));
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    expect(await screen.findByText("Father's Day")).toBeInTheDocument();
  });

  it("renders an empty state when no tags exist yet", async () => {
    mockBaseLoads();
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockRejectedValue(new ApiError("Not found", 404));
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    expect(await screen.findByText("No Marketing Tags yet.")).toBeInTheDocument();
  });

  it("Add Tag calls the explicit add endpoint with the typed label and reloads the list", async () => {
    const user = userEvent.setup();
    mockBaseLoads();
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockRejectedValue(new ApiError("Not found", 404));
    const addSpy = vi.spyOn(marketingTagsLib.marketingTagsApi, "add").mockResolvedValue({ id: "tag-1", key: "christmas", label: "Christmas", createdAt: "t", updatedAt: "t" } as any);
    const listSpy = vi.spyOn(marketingTagsLib.marketingTagsApi, "list").mockResolvedValue([]);
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    await screen.findByText("No Marketing Tags yet.");
    const input = screen.getByPlaceholderText("e.g. Father's Day");
    await user.type(input, "Christmas");
    await user.click(screen.getByRole("button", { name: "Add Tag" }));
    await waitFor(() => expect(addSpy).toHaveBeenCalledWith("product-1", "Christmas"));
    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(2)); // initial load + reload after add
  });

  it("Remove Tag calls the explicit remove endpoint for exactly that relation", async () => {
    const user = userEvent.setup();
    mockBaseLoads();
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockRejectedValue(new ApiError("Not found", 404));
    vi.spyOn(marketingTagsLib.marketingTagsApi, "list").mockResolvedValue([
      { id: "tag-1", key: "fathers-day", label: "Father's Day", createdAt: "t", updatedAt: "t" },
    ] as any);
    const removeSpy = vi.spyOn(marketingTagsLib.marketingTagsApi, "remove").mockResolvedValue(undefined as any);
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    await screen.findByText("Father's Day");
    await user.click(screen.getByRole("button", { name: "Remove Father's Day" }));
    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith("product-1", "tag-1"));
  });

  it("no replace-all/bulk-save action exists for Marketing Tags", async () => {
    mockBaseLoads();
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockRejectedValue(new ApiError("Not found", 404));
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    await screen.findByText("No Marketing Tags yet.");
    expect(screen.queryByRole("button", { name: /save tags/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /replace/i })).not.toBeInTheDocument();
  });
});

/**
 * Sprint 141: unified channel selection & publish - page-global, transient checkbox state,
 * independent of the existing channel dropdown above (which continues to drive Preview/Prepare
 * with AI/Regenerate with AI/Approve/Connection for one channel at a time). Delegates every
 * selected channel to the existing, unmodified Execute Publish authority via one new batch
 * request - never a second publishing implementation.
 */
describe("ProductPublishingPage - Unified Channel Selection & Publish (Sprint 141)", () => {
  it("renders a checkbox for each of the three publish channels and a disabled Publish Selected button when none are selected", async () => {
    mockBaseLoads();
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockRejectedValue(new ApiError("Not found", 404));
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    expect(await screen.findByRole("checkbox", { name: "Noctella Web" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "eBay" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Etsy" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish Selected" })).toBeDisabled();
  });

  it("selecting one channel enables Publish Selected; multiple channels can be selected together", async () => {
    const user = userEvent.setup();
    mockBaseLoads();
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockRejectedValue(new ApiError("Not found", 404));
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    const web = await screen.findByRole("checkbox", { name: "Noctella Web" });
    const ebay = screen.getByRole("checkbox", { name: "eBay" });
    await user.click(web);
    expect(screen.getByRole("button", { name: "Publish Selected" })).not.toBeDisabled();
    await user.click(ebay);
    expect(web).toBeChecked();
    expect(ebay).toBeChecked();
  });

  it("changing the existing channel dropdown does not clear the unified checkbox selection", async () => {
    const user = userEvent.setup();
    mockBaseLoads();
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockRejectedValue(new ApiError("Not found", 404));
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    const web = await screen.findByRole("checkbox", { name: "Noctella Web" });
    await user.click(web);
    expect(web).toBeChecked();
    await user.selectOptions(screen.getByRole("combobox"), "noctella_web");
    expect(screen.getByRole("checkbox", { name: "Noctella Web" })).toBeChecked();
  });

  it("Publish Selected sends exactly the selected channels in one batch request, with no idempotency key, and renders truthful per-channel results", async () => {
    const user = userEvent.setup();
    mockBaseLoads();
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockRejectedValue(new ApiError("Not found", 404));
    const batchSpy = vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch").mockResolvedValue({
      productId: "product-1",
      results: [
        { channel: PublishChannel.NoctellaWeb, outcome: "succeeded", result: {} as any },
        { channel: PublishChannel.Ebay, outcome: "failed", error: { message: "Marketplace connection is not connected" } },
      ],
    } as any);
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    await user.click(await screen.findByRole("checkbox", { name: "Noctella Web" }));
    await user.click(screen.getByRole("checkbox", { name: "eBay" }));
    await user.click(screen.getByRole("button", { name: "Publish Selected" }));
    await waitFor(() => expect(batchSpy).toHaveBeenCalledWith("product-1", [PublishChannel.NoctellaWeb, PublishChannel.Ebay]));
    expect(batchSpy.mock.calls[0]).toHaveLength(2); // exactly (productId, channels) - no idempotency-key argument
    // Partial truth: Web's success remains visible alongside eBay's failure - never collapsed into one global message.
    expect(await screen.findByText(/Noctella Web — Published/)).toBeInTheDocument();
    expect(screen.getByText(/eBay — Failed: Marketplace connection is not connected/)).toBeInTheDocument();
  });

  it("renders a skipped/already-published result distinctly from success and failure", async () => {
    const user = userEvent.setup();
    mockBaseLoads();
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockRejectedValue(new ApiError("Not found", 404));
    vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch").mockResolvedValue({
      productId: "product-1",
      results: [{ channel: PublishChannel.Ebay, outcome: "skipped", error: { message: "An active listing already exists for this product on this channel" } }],
    } as any);
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    await user.click(await screen.findByRole("checkbox", { name: "eBay" }));
    await user.click(screen.getByRole("button", { name: "Publish Selected" }));
    expect(await screen.findByText(/eBay — Already published/)).toBeInTheDocument();
  });

  it("shows a request-level error without crashing, using the existing safe error rendering convention", async () => {
    const user = userEvent.setup();
    mockBaseLoads();
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockRejectedValue(new ApiError("Not found", 404));
    vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch").mockRejectedValue(new ApiError("Failed to publish selected channels", 500));
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    await user.click(await screen.findByRole("checkbox", { name: "eBay" }));
    await user.click(screen.getByRole("button", { name: "Publish Selected" }));
    await screen.findByText("Failed to publish selected channels");
  });

  it("does not introduce SKU, Inventory, or Product status editing controls", async () => {
    mockBaseLoads();
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockRejectedValue(new ApiError("Not found", 404));
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    await screen.findByRole("button", { name: "Publish Selected" });
    expect(screen.queryByLabelText(/sku/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/stock quantity/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^status$/i)).not.toBeInTheDocument();
  });

  it("existing dropdown-driven Prepare with AI remains channel-local and unaffected by the unified selection", async () => {
    const user = userEvent.setup();
    mockBaseLoads();
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockRejectedValue(new ApiError("Not found", 404));
    const generateSpy = vi.spyOn(publishingLib.marketplacePreparationApi, "generate").mockResolvedValue({
      id: "prep-1", productId: "product-1", channel: PublishChannel.Ebay, status: "pending",
      baseProductUpdatedAt: "t", providerName: "mock", promptVersion: "v1", generatedAt: "t", createdAt: "t", updatedAt: "t",
    } as any);
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    await user.click(await screen.findByRole("checkbox", { name: "Noctella Web" })); // unified selection touched first
    await user.click(screen.getByRole("button", { name: "Prepare with AI" }));
    await waitFor(() => expect(generateSpy).toHaveBeenCalledWith("product-1", PublishChannel.Ebay)); // dropdown default channel, unaffected by checkbox state
  });

  it("Price editor and Marketing Tags editor remain functional alongside the new unified selection", async () => {
    const user = userEvent.setup();
    mockBaseLoads();
    vi.spyOn(apiLib.api, "get").mockImplementation((path: string) => {
      if (path === "/api/products/product-1") return Promise.resolve(product({ priceEur: 42 })) as any;
      return Promise.reject(new Error(`Unexpected path: ${path}`));
    });
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockRejectedValue(new ApiError("Not found", 404));
    render(<ProductPublishingPage params={{ id: "product-1" }} />);
    expect(await screen.findByDisplayValue("42")).toBeInTheDocument(); // Price editor still loads
    await user.click(await screen.findByRole("checkbox", { name: "Noctella Web" }));
    expect(screen.getByDisplayValue("42")).toBeInTheDocument(); // untouched by the unified selection
    expect(screen.getByRole("button", { name: "Add Tag" })).toBeInTheDocument(); // Marketing Tags editor still present
  });
});
