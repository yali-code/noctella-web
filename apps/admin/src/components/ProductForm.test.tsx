// @vitest-environment jsdom
// Sprint 88 (ADR-017): proves ProductForm's PRODUCT_VERSION_CONFLICT handling - values are
// preserved, no automatic reload/resubmit occurs, and the reload callback fires only on an
// explicit user click - without disturbing the existing ordinary ApiError.details field-error
// behavior. Follows the jsdom/testing-library conventions established by app/offers/page.test.tsx.
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/api";
import * as apiLib from "@/lib/api";
import * as marketingTagsLib from "@/lib/marketingTags";
import * as publishingLib from "@/lib/publishing";
import * as marketplacesLib from "@/lib/marketplaces";
import * as canonicalProductProposalsLib from "@/lib/canonicalProductProposals";
import { ProductForm, emptyProductForm, productToFormValues } from "./ProductForm";

afterEach(() => vi.restoreAllMocks());

/**
 * Sprint 145/146/148: every productId-bearing render now also mounts three AiChannelSuggestionsSection
 * instances (eBay/Etsy/Web), one CanonicalProductAiSuggestionsSection instance, and one
 * PublishActions instance, each of which calls its own read API on mount
 * (marketplacePreparationApi.get / canonicalProductProposalApi.get / publishingApi.getPreview /
 * marketplaceApi.listConnections). Defaults every test in this file to safe, deterministic
 * responses so pre-existing tests (SKU lock, Published protection, Marketing Tags) never make a
 * real, unmocked network call - mirrors publishing/page.test.tsx's own established default-mock
 * convention for exactly this reason. Individual tests below override any of these per-test as
 * needed.
 */
beforeEach(() => {
  vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockRejectedValue(new ApiError("Marketplace preparation not found", 404));
  vi.spyOn(canonicalProductProposalsLib.canonicalProductProposalApi, "get").mockRejectedValue(new ApiError("Canonical product AI proposal not found", 404));
  vi.spyOn(publishingLib.publishingApi, "getPreview").mockRejectedValue(new Error("not mocked in this test"));
  vi.spyOn(marketplacesLib.marketplaceApi, "listConnections").mockResolvedValue([]);
});

function baseValues() {
  return { ...emptyProductForm, sku: "SKU-1", title: "Original Title", priceEur: "100", categoryId: "cat-1" };
}

function baseProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    sku: "SKU-1",
    title: "Original Title",
    slug: "original-title",
    type: "unique_item",
    status: "draft",
    categoryId: "cat-1",
    stockQuantity: 1,
    customsWarning: false,
    isFeatured: false,
    allowMakeOffer: false,
    allowCashOnDelivery: false,
    showInArchiveAfterSale: false,
    priceEur: 100,
    photos: [],
    images: [],
    marketplaceReadiness: {},
    createdAt: "t",
    updatedAt: "t",
    ...overrides,
  } as any;
}

describe("Sprint 137: ProductForm with a null priceEur (unpriced Draft/Approved Product)", () => {
  it("productToFormValues does not throw when priceEur is null, and represents it as a blank string", () => {
    expect(() => productToFormValues(baseProduct({ priceEur: null }))).not.toThrow();
    expect(productToFormValues(baseProduct({ priceEur: null })).priceEur).toBe("");
  });

  it("productToFormValues still renders the exact existing price when one is set", () => {
    expect(productToFormValues(baseProduct({ priceEur: 249.5 })).priceEur).toBe("249.5");
  });

  it("renders a blank (never crashing, never fabricated) EUR Price input for an unpriced Product", () => {
    render(
      <ProductForm
        initialValues={productToFormValues(baseProduct({ priceEur: null }))}
        submitLabel="Save Changes"
        onSubmit={vi.fn()}
      />,
    );
    const priceInput = screen.getByLabelText("EUR Price") as HTMLInputElement;
    expect(priceInput.value).toBe("");
  });

  it("Admin can type a real price into a previously blank EUR Price field", async () => {
    const user = userEvent.setup();
    render(
      <ProductForm
        initialValues={productToFormValues(baseProduct({ priceEur: null }))}
        submitLabel="Save Changes"
        onSubmit={vi.fn()}
      />,
    );
    const priceInput = screen.getByLabelText("EUR Price") as HTMLInputElement;
    await user.type(priceInput, "349");
    expect(priceInput.value).toBe("349");
  });
});

describe("Sprint 137 Required Fix Correction: explicit sales-price clear via ProductForm submit payload", () => {
  // "Listing Price (EUR)" is used identically by the eBay, Etsy, and Noctella Web (woo*-backed)
  // sections (in that render order); only the Noctella Web one (index 2) participates in the
  // approved effective-price invariant, so tests targeting it disambiguate via getAllByLabelText.
  function wooListingPriceInput(): HTMLInputElement {
    return screen.getAllByLabelText("Listing Price (EUR)")[2] as HTMLInputElement;
  }

  async function submitAfterClearing(product: Record<string, unknown>, field: string | (() => HTMLInputElement)) {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ProductForm
        initialValues={productToFormValues(baseProduct(product))}
        submitLabel="Save Changes"
        onSubmit={onSubmit}
      />,
    );
    const target = typeof field === "function" ? field() : (screen.getByLabelText(field) as HTMLInputElement);
    await user.clear(target);
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    return onSubmit.mock.calls[0][0] as Record<string, unknown>;
  }

  it("Draft: blanking a previously-set EUR Price sends literal priceEur: null on the wire", async () => {
    const payload = await submitAfterClearing({ status: "draft", priceEur: 100 }, "EUR Price");
    expect(Object.prototype.hasOwnProperty.call(payload, "priceEur")).toBe(true);
    expect(payload.priceEur).toBeNull();
    expect(JSON.stringify(payload)).toContain('"priceEur":null');
  });

  it("Approved: blanking a previously-set EUR Price also sends literal priceEur: null (status does not change this behavior)", async () => {
    const payload = await submitAfterClearing({ status: "approved", priceEur: 100 }, "EUR Price");
    expect(Object.prototype.hasOwnProperty.call(payload, "priceEur")).toBe(true);
    expect(payload.priceEur).toBeNull();
    expect(JSON.stringify(payload)).toContain('"priceEur":null');
  });

  it("untouched EUR Price: editing an unrelated field does not send priceEur at all (no accidental clear)", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ProductForm
        initialValues={productToFormValues(baseProduct({ status: "draft", priceEur: 100 }))}
        submitLabel="Save Changes"
        onSubmit={onSubmit}
      />,
    );
    await user.clear(screen.getByLabelText("Brand"));
    await user.type(screen.getByLabelText("Brand"), "Acme");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0] as Record<string, unknown>;
    // "untouched" is signalled as an undefined value, which JSON.stringify then drops from the
    // actual wire body - the wire-level check is what matters (the object literal itself always
    // has an own "priceEur" key, per normal JS semantics, even when its value is undefined).
    expect(payload.priceEur).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('"priceEur"');
  });

  it("numeric edit from an existing price: entering a new value sends the number, not null or a placeholder", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ProductForm
        initialValues={productToFormValues(baseProduct({ status: "draft", priceEur: 100 }))}
        submitLabel="Save Changes"
        onSubmit={onSubmit}
      />,
    );
    const priceInput = screen.getByLabelText("EUR Price") as HTMLInputElement;
    await user.clear(priceInput);
    await user.type(priceInput, "125");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].priceEur).toBe(125);
  });

  it("numeric edit from an unpriced (null) product: entering a value sends the number", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ProductForm
        initialValues={productToFormValues(baseProduct({ status: "draft", priceEur: null }))}
        submitLabel="Save Changes"
        onSubmit={onSubmit}
      />,
    );
    const priceInput = screen.getByLabelText("EUR Price") as HTMLInputElement;
    await user.type(priceInput, "125");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].priceEur).toBe(125);
  });

  it("Create mode: leaving EUR Price blank on a fresh form still omits priceEur (unchanged create semantics)", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ProductForm initialValues={emptyProductForm} submitLabel="Create" onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText("SKU"), "SKU-NEW");
    // "Title" is shared with the eBay/Etsy sections; the Core one renders first.
    await user.type(screen.getAllByLabelText("Title")[0], "New Product");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.priceEur).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('"priceEur"');
  });

  it("Published safety (client side): clearing the base price on a Published product with a valid wooListingPriceEur override sends priceEur: null while leaving the untouched override omitted - server remains authoritative for whether this is allowed", async () => {
    const payload = await submitAfterClearing(
      { status: "published", priceEur: 100, wooListingPriceEur: 105 },
      "EUR Price",
    );
    expect(payload.priceEur).toBeNull();
    expect(payload.wooListingPriceEur).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('"wooListingPriceEur"');
  });

  it("wooListingPriceEur: blanking a previously-set Noctella Web override sends literal wooListingPriceEur: null", async () => {
    const payload = await submitAfterClearing(
      { status: "draft", priceEur: 100, wooListingPriceEur: 105 },
      wooListingPriceInput,
    );
    expect(payload.wooListingPriceEur).toBeNull();
    expect(JSON.stringify(payload)).toContain('"wooListingPriceEur":null');
    // base priceEur was never touched in this scenario.
    expect(payload.priceEur).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('"priceEur"');
  });
});

describe("ProductForm — Sprint 88 version-conflict handling", () => {
  it("preserves field values, shows the conflict message and a Reload Latest Product action, and does not reload or resubmit automatically", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValue(
      new ApiError("This product changed after you opened it. Reload the latest version before saving again.", 409, undefined, "PRODUCT_VERSION_CONFLICT", {
        productId: "p1",
        expectedUpdatedAt: "old",
        currentUpdatedAt: "new",
      }),
    );
    const onVersionConflictReload = vi.fn();

    render(
      <ProductForm
        initialValues={baseValues()}
        submitLabel="Save Changes"
        onSubmit={onSubmit}
        onVersionConflictReload={onVersionConflictReload}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/no local changes were written/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload Latest Product" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("Original Title")).toBeInTheDocument();

    // No automatic reload or resubmit happens merely from receiving the conflict.
    expect(onVersionConflictReload).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Reload Latest Product" }));
    expect(onVersionConflictReload).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("leaves ordinary ApiError.details field-validation behavior unchanged", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValue(
      new ApiError("Validation failed", 400, [{ path: "title", message: "Title is required" }]),
    );

    render(<ProductForm initialValues={baseValues()} submitLabel="Save Changes" onSubmit={onSubmit} />);

    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Title is required")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reload Latest Product" })).not.toBeInTheDocument();
  });
});

/**
 * Sprint 144: Canonical Product Edit foundation - `productId` is the explicit edit-mode signal
 * (supplied only by products/[id]/edit/page.tsx, never by products/new/page.tsx). Proves: SKU is
 * locked to read-only only when editing an existing Product; the Marketing Tags section mounts
 * (and calls the Marketing Tags API) only in that same mode.
 */
describe("ProductForm — Sprint 144: SKU immutability on an existing Product", () => {
  it("SKU remains a plain editable input in create mode (no productId)", async () => {
    const user = userEvent.setup();
    render(<ProductForm initialValues={emptyProductForm} submitLabel="Create" onSubmit={vi.fn()} />);
    const skuInput = screen.getByLabelText("SKU") as HTMLInputElement;
    expect(skuInput).not.toBeDisabled();
    await user.type(skuInput, "SKU-NEW");
    expect(skuInput.value).toBe("SKU-NEW");
  });

  it("SKU is rendered read-only and disabled when editing an existing Product (productId supplied)", () => {
    render(
      <ProductForm
        initialValues={productToFormValues(baseProduct())}
        submitLabel="Save Changes"
        onSubmit={vi.fn()}
        productId="p1"
      />,
    );
    const skuInput = screen.getByLabelText("SKU") as HTMLInputElement;
    expect(skuInput).toBeDisabled();
    expect(skuInput.value).toBe("SKU-1");
  });

  it("an unchanged (disabled) SKU is still submitted unchanged - no accidental value loss", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ProductForm
        initialValues={productToFormValues(baseProduct())}
        submitLabel="Save Changes"
        onSubmit={onSubmit}
        productId="p1"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].sku).toBe("SKU-1");
  });
});

describe("ProductForm — Sprint 144: ProductStatus.Published protection", () => {
  it("Published is never offered as a selectable Status option (Draft/Approved product)", () => {
    render(
      <ProductForm
        initialValues={productToFormValues(baseProduct({ status: "draft" }))}
        submitLabel="Save Changes"
        onSubmit={vi.fn()}
        productId="p1"
      />,
    );
    // Scoped to the Status combobox itself - eBay/Etsy/Web Listing Status selects also have a
    // "draft" option (ListingStatus.Draft), so an unscoped query would be ambiguous.
    const statusSelect = screen.getByRole("combobox", { name: "Status" });
    expect(within(statusSelect).queryByRole("option", { name: "published" })).not.toBeInTheDocument();
    // Draft/Approved remain freely selectable - unaffected by the Published exclusion.
    expect(within(statusSelect).getByRole("option", { name: "draft" })).toBeInTheDocument();
    expect(within(statusSelect).getByRole("option", { name: "approved" })).toBeInTheDocument();
  });

  it("an already-Published Product renders Status as a locked, read-only display - no dropdown, no way to change it here", () => {
    render(
      <ProductForm
        initialValues={productToFormValues(baseProduct({ status: "published" }))}
        submitLabel="Save Changes"
        onSubmit={vi.fn()}
        productId="p1"
      />,
    );
    expect(screen.queryByRole("combobox", { name: "Status" })).not.toBeInTheDocument();
    const statusInput = screen.getByLabelText("Status") as HTMLInputElement;
    expect(statusInput).toBeDisabled();
    expect(statusInput.value).toBe("published");
  });

  it("saving a Published Product with an unrelated field change preserves status: 'published' unchanged on the wire", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ProductForm
        initialValues={productToFormValues(baseProduct({ status: "published" }))}
        submitLabel="Save Changes"
        onSubmit={onSubmit}
        productId="p1"
      />,
    );
    await user.clear(screen.getByLabelText("Brand"));
    await user.type(screen.getByLabelText("Brand"), "Acme");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].status).toBe("published");
  });
});

describe("ProductForm — Sprint 144: Marketing Tags inside canonical Edit", () => {
  afterEach(() => vi.restoreAllMocks());

  it("create mode (no productId) never renders the Marketing Tags section and never calls the Marketing Tags API", () => {
    const listSpy = vi.spyOn(marketingTagsLib.marketingTagsApi, "list");
    render(<ProductForm initialValues={emptyProductForm} submitLabel="Create" onSubmit={vi.fn()} />);
    expect(screen.queryByText("Marketing Tags")).not.toBeInTheDocument();
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("edit mode loads and lists the Product's existing Marketing Tags", async () => {
    vi.spyOn(marketingTagsLib.marketingTagsApi, "list").mockResolvedValue([
      { id: "tag-1", key: "christmas", label: "Christmas", createdAt: "t", updatedAt: "t" } as any,
    ]);
    render(
      <ProductForm
        initialValues={productToFormValues(baseProduct())}
        submitLabel="Save Changes"
        onSubmit={vi.fn()}
        productId="p1"
      />,
    );
    expect(await screen.findByText("Christmas")).toBeInTheDocument();
  });

  it("adding a Marketing Tag calls the existing add API and does not submit/save the Product form", async () => {
    const user = userEvent.setup();
    const addSpy = vi.spyOn(marketingTagsLib.marketingTagsApi, "add").mockResolvedValue({
      id: "tag-2",
      key: "fathers-day",
      label: "Father's Day",
      createdAt: "t",
      updatedAt: "t",
    } as any);
    vi.spyOn(marketingTagsLib.marketingTagsApi, "list").mockResolvedValue([]);
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ProductForm
        initialValues={productToFormValues(baseProduct())}
        submitLabel="Save Changes"
        onSubmit={onSubmit}
        productId="p1"
      />,
    );
    await screen.findByText("No Marketing Tags yet.");
    await user.type(screen.getByPlaceholderText("e.g. Father's Day"), "Father's Day");
    await user.click(screen.getByRole("button", { name: "Add Tag" }));
    await waitFor(() => expect(addSpy).toHaveBeenCalledWith("p1", "Father's Day"));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("removing a Marketing Tag calls the existing remove API and does not submit/save the Product form", async () => {
    const user = userEvent.setup();
    vi.spyOn(marketingTagsLib.marketingTagsApi, "list").mockResolvedValue([
      { id: "tag-1", key: "christmas", label: "Christmas", createdAt: "t", updatedAt: "t" } as any,
    ]);
    const removeSpy = vi.spyOn(marketingTagsLib.marketingTagsApi, "remove").mockResolvedValue(undefined as any);
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ProductForm
        initialValues={productToFormValues(baseProduct())}
        submitLabel="Save Changes"
        onSubmit={onSubmit}
        productId="p1"
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Remove Christmas" }));
    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith("p1", "tag-1"));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("adding a Marketing Tag does not reset the Product form's own unsaved field values", async () => {
    const user = userEvent.setup();
    vi.spyOn(marketingTagsLib.marketingTagsApi, "list").mockResolvedValue([]);
    vi.spyOn(marketingTagsLib.marketingTagsApi, "add").mockResolvedValue({
      id: "tag-3",
      key: "vintage",
      label: "Vintage",
      createdAt: "t",
      updatedAt: "t",
    } as any);
    render(
      <ProductForm
        initialValues={productToFormValues(baseProduct())}
        submitLabel="Save Changes"
        onSubmit={vi.fn()}
        productId="p1"
      />,
    );
    await screen.findByText("No Marketing Tags yet.");
    await user.clear(screen.getByLabelText("Brand"));
    await user.type(screen.getByLabelText("Brand"), "Acme");
    await user.type(screen.getByPlaceholderText("e.g. Father's Day"), "Vintage");
    await user.click(screen.getByRole("button", { name: "Add Tag" }));
    await waitFor(() => expect(marketingTagsLib.marketingTagsApi.add).toHaveBeenCalled());
    expect((screen.getByLabelText("Brand") as HTMLInputElement).value).toBe("Acme");
  });

  it("a Marketing Tag load failure is shown locally and does not corrupt or block the rest of the Product form", async () => {
    vi.spyOn(marketingTagsLib.marketingTagsApi, "list").mockRejectedValue(
      new ApiError("Failed to load Marketing Tags", 500),
    );
    render(
      <ProductForm
        initialValues={productToFormValues(baseProduct())}
        submitLabel="Save Changes"
        onSubmit={vi.fn()}
        productId="p1"
      />,
    );
    expect(await screen.findByText("Failed to load Marketing Tags")).toBeInTheDocument();
    expect(screen.getByLabelText("Brand")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Changes" })).not.toBeDisabled();
  });
});

/**
 * Sprint 145: AI Suggestions integration - the NONE/PENDING+FRESH/PENDING+STALE/APPLIED state
 * machine and error surfacing themselves are covered in AiChannelSuggestionsSection.test.tsx;
 * these tests cover exactly what only ProductForm itself owns - create-mode absence, the narrow
 * channel-scoped field merge, unsaved-edit preservation, and version-token advancement.
 */
describe("ProductForm — Sprint 145: AI Suggestions integration", () => {
  it("create mode never mounts AI Suggestions and never calls marketplacePreparationApi", () => {
    const getSpy = vi.spyOn(publishingLib.marketplacePreparationApi, "get");
    render(<ProductForm initialValues={emptyProductForm} submitLabel="Create" onSubmit={vi.fn()} />);
    expect(screen.queryByText("AI Suggestions")).not.toBeInTheDocument();
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("Accept on Etsy merges only Etsy-owned fields, preserves an unrelated unsaved Brand edit and eBay's own untouched Title, advances the version token, and a later Save reflects both", async () => {
    const user = userEvent.setup();
    // eBay/Web stay at the default NONE (404) mock from the file-level beforeEach; only Etsy resolves a fresh proposal.
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockImplementation(async (_productId: string, channel: any) => {
      if (channel === "etsy") {
        return {
          id: "prep-1",
          productId: "p1",
          channel: "etsy",
          status: "pending",
          baseProductUpdatedAt: "t",
          suggestedTitle: "AI Etsy Title",
          suggestedDescription: "AI Etsy Description",
          suggestedTags: ["vintage"],
          providerName: "mock",
          promptVersion: "v1",
          generatedAt: "t",
          createdAt: "t",
          updatedAt: "t",
        } as any;
      }
      throw new ApiError("Not found", 404);
    });
    const returnedProduct = baseProduct({
      updatedAt: "2026-02-01T00:00:00.000Z",
      etsyTitle: "AI Etsy Title",
      etsyDescription: "AI Etsy Description",
      etsyTags: ["vintage"],
    });
    const approveSpy = vi.spyOn(publishingLib.marketplacePreparationApi, "approve").mockResolvedValue(returnedProduct as any);
    const onProductVersionAdvanced = vi.fn();
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <ProductForm
        initialValues={productToFormValues(baseProduct())}
        submitLabel="Save Changes"
        onSubmit={onSubmit}
        productId="p1"
        productUpdatedAt="t"
        onProductVersionAdvanced={onProductVersionAdvanced}
      />,
    );

    // A manual, unsaved edit elsewhere in the form - must survive the Etsy Accept below.
    await user.clear(screen.getByLabelText("Brand"));
    await user.type(screen.getByLabelText("Brand"), "Acme");

    await user.click(await screen.findByRole("button", { name: "Accept AI Suggestions" }));
    await waitFor(() => expect(approveSpy).toHaveBeenCalledWith("p1", {
      channel: "etsy",
      expectedProposalUpdatedAt: "t",
      title: "AI Etsy Title",
      description: "AI Etsy Description",
      tags: ["vintage"],
    }));
    await waitFor(() => expect(onProductVersionAdvanced).toHaveBeenCalledWith("2026-02-01T00:00:00.000Z"));

    // Etsy fields now reflect the AI-accepted values.
    expect((screen.getByLabelText("Tags (comma-separated)") as HTMLInputElement).value).toBe("vintage");
    // The unrelated manual Brand edit was never discarded by the Approve/merge.
    expect((screen.getByLabelText("Brand") as HTMLInputElement).value).toBe("Acme");
    // eBay's own Title field (index 1: Core, eBay, Etsy each render a "Title" label) stays untouched.
    expect((screen.getAllByLabelText("Title")[1] as HTMLInputElement).value).toBe("");

    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.etsyTitle).toBe("AI Etsy Title");
    expect(payload.brand).toBe("Acme");
  });

  it("a version-conflict Approve failure surfaces its own local error, never calls onProductVersionAdvanced, and leaves Marketing Tags and other fields unaffected", async () => {
    const user = userEvent.setup();
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockImplementation(async (_productId: string, channel: any) => {
      if (channel === "ebay") {
        return {
          id: "prep-ebay",
          productId: "p1",
          channel: "ebay",
          status: "pending",
          baseProductUpdatedAt: "t",
          suggestedTitle: "AI Ebay Title",
          providerName: "mock",
          promptVersion: "v1",
          generatedAt: "t",
          createdAt: "t",
          updatedAt: "t",
        } as any;
      }
      throw new ApiError("Not found", 404);
    });
    vi.spyOn(publishingLib.marketplacePreparationApi, "approve").mockRejectedValue(
      new ApiError("This marketplace preparation changed since you loaded it. Reload it and try again.", 409, undefined, "MARKETPLACE_PREPARATION_VERSION_CONFLICT"),
    );
    vi.spyOn(marketingTagsLib.marketingTagsApi, "list").mockResolvedValue([
      { id: "tag-1", key: "vintage", label: "Vintage", createdAt: "t", updatedAt: "t" } as any,
    ]);
    const onProductVersionAdvanced = vi.fn();

    render(
      <ProductForm
        initialValues={productToFormValues(baseProduct())}
        submitLabel="Save Changes"
        onSubmit={vi.fn()}
        productId="p1"
        productUpdatedAt="t"
        onProductVersionAdvanced={onProductVersionAdvanced}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Accept AI Suggestions" }));
    expect(await screen.findByText(/changed since you loaded it/)).toBeInTheDocument();
    expect(onProductVersionAdvanced).not.toHaveBeenCalled();

    // Marketing Tags (a fully independent section) is unaffected by the failed Accept.
    expect(await screen.findByText("Vintage")).toBeInTheDocument();
    // eBay's own Title field was never touched by the failed Accept.
    expect((screen.getAllByLabelText("Title")[1] as HTMLInputElement).value).toBe("");
  });
});

describe("ProductForm — Sprint 148: canonical AI Suggestions integration", () => {
  it("create mode never mounts the canonical AI Suggestions panel and never calls canonicalProductProposalApi", () => {
    const getSpy = vi.spyOn(canonicalProductProposalsLib.canonicalProductProposalApi, "get");
    render(<ProductForm initialValues={emptyProductForm} submitLabel="Create" onSubmit={vi.fn()} />);
    expect(screen.queryByText("AI Product Suggestions")).not.toBeInTheDocument();
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("Accept merges only the selected fields, preserves an unrelated unsaved edit and an unselected suggested field, advances the version token, refreshes Marketing Tags, and a later Save reflects the merged value", async () => {
    const user = userEvent.setup();
    vi.spyOn(canonicalProductProposalsLib.canonicalProductProposalApi, "get").mockResolvedValue({
      id: "cpp-1",
      productId: "p1",
      status: "pending",
      baseProductUpdatedAt: "t",
      suggestedBrand: "Omega",
      suggestedModel: "Speedmaster",
      suggestedMarketingTags: ["Father's Day"],
      providerName: "mock",
      promptVersion: "v1",
      generatedAt: "t",
      createdAt: "t",
      updatedAt: "t",
    } as any);
    const returnedProduct = baseProduct({ updatedAt: "2026-03-01T00:00:00.000Z", brand: "Omega" });
    const acceptSpy = vi.spyOn(canonicalProductProposalsLib.canonicalProductProposalApi, "accept").mockResolvedValue(returnedProduct as any);
    const listTagsSpy = vi.spyOn(marketingTagsLib.marketingTagsApi, "list").mockResolvedValue([]);
    const onProductVersionAdvanced = vi.fn();
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <ProductForm
        initialValues={productToFormValues(baseProduct())}
        submitLabel="Save Changes"
        onSubmit={onSubmit}
        productId="p1"
        productUpdatedAt="t"
        onProductVersionAdvanced={onProductVersionAdvanced}
      />,
    );

    // An unrelated, unsaved manual edit elsewhere in the form - must survive the Accept below.
    await user.clear(screen.getByLabelText("Manufacturer"));
    await user.type(screen.getByLabelText("Manufacturer"), "Acme Co");

    await screen.findByText("Omega");
    // Brand was blank -> pre-selected by default. Model was also blank -> pre-selected too;
    // deselect it explicitly so only Brand is accepted. Marketing Tags are additive-only, so
    // every suggested tag is already pre-selected by default - "Father's Day" needs no click.
    await user.click(screen.getByRole("checkbox", { name: /Model/ }));
    await user.click(screen.getByRole("button", { name: "Accept AI Suggestions" }));

    await waitFor(() =>
      expect(acceptSpy).toHaveBeenCalledWith("p1", {
        expectedProposalUpdatedAt: "t",
        selectedProductFields: ["brand"],
        selectedMarketingTags: ["Father's Day"],
      }),
    );
    await waitFor(() => expect(onProductVersionAdvanced).toHaveBeenCalledWith("2026-03-01T00:00:00.000Z"));
    await waitFor(() => expect(listTagsSpy.mock.calls.length).toBeGreaterThanOrEqual(2)); // initial mount + post-Accept refresh signal

    // Brand now reflects the accepted suggestion.
    expect((screen.getByLabelText("Brand") as HTMLInputElement).value).toBe("Omega");
    // Model was suggested but explicitly deselected - never applied.
    expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("");
    // The unrelated manual Manufacturer edit was never discarded by the merge.
    expect((screen.getByLabelText("Manufacturer") as HTMLInputElement).value).toBe("Acme Co");

    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.brand).toBe("Omega");
    expect(payload.manufacturer).toBe("Acme Co");
  });

  it("a version-conflict Accept failure surfaces its own local error and never calls onProductVersionAdvanced", async () => {
    const user = userEvent.setup();
    vi.spyOn(canonicalProductProposalsLib.canonicalProductProposalApi, "get").mockResolvedValue({
      id: "cpp-1",
      productId: "p1",
      status: "pending",
      baseProductUpdatedAt: "t",
      suggestedBrand: "Omega",
      providerName: "mock",
      promptVersion: "v1",
      generatedAt: "t",
      createdAt: "t",
      updatedAt: "t",
    } as any);
    vi.spyOn(canonicalProductProposalsLib.canonicalProductProposalApi, "accept").mockRejectedValue(
      new ApiError("This canonical product AI proposal changed since you loaded it. Reload it and try again.", 409, undefined, "CANONICAL_PRODUCT_PROPOSAL_VERSION_CONFLICT"),
    );
    const onProductVersionAdvanced = vi.fn();

    render(
      <ProductForm
        initialValues={productToFormValues(baseProduct())}
        submitLabel="Save Changes"
        onSubmit={vi.fn()}
        productId="p1"
        productUpdatedAt="t"
        onProductVersionAdvanced={onProductVersionAdvanced}
      />,
    );

    await screen.findByText("Omega");
    await user.click(screen.getByRole("button", { name: "Accept AI Suggestions" }));
    expect(await screen.findByText(/changed since you loaded it/)).toBeInTheDocument();
    expect(onProductVersionAdvanced).not.toHaveBeenCalled();
    // Brand was never applied - the failed Accept never touched the form.
    expect((screen.getByLabelText("Brand") as HTMLInputElement).value).toBe("");
  });
});

/**
 * Sprint 146: canonical publishing integration - PublishActions' own channel-selection/result/
 * connection/preview behavior is covered in isolation in PublishActions.test.tsx (its
 * saveForPublish/onProductRefreshed props are passed in directly as mocks there); these tests
 * cover exactly what only ProductForm itself owns end-to-end - the persisted-baseline/dirty
 * signal PublishActions consumes, the real Save-before-Publish wiring through
 * onSaveForPublish, the AI-Approve-advances-baseline rule, and the post-publish canonical
 * refresh's effect on the visible form (including the Published-status display).
 */
/**
 * Sprint 146: routes api.get by path so categories/collections/marketing-tags never receive an
 * unrelated response shape (e.g. the returned Product) - a blanket mockResolvedValue would crash
 * categories.map(), exactly the footgun this file's own top comment already documents for the
 * Marketing Tags addition. `productResponse` answers any GET for the Product itself, which is what
 * PublishActions' post-publish refetch (GET /api/products/p1) needs.
 */
function mockProductFormGets(productResponse: unknown) {
  return vi.spyOn(apiLib.api, "get").mockImplementation(async (path: string) => {
    if (path === "/api/products/p1") return productResponse;
    if (path === "/api/products/p1/marketing-tags") return [];
    return { items: [] };
  });
}

describe("ProductForm — Sprint 146: canonical publishing integration", () => {
  it("no Save as Draft action exists anywhere in the canonical form", () => {
    render(
      <ProductForm initialValues={productToFormValues(baseProduct())} submitLabel="Save Changes" onSubmit={vi.fn()} productId="p1" productUpdatedAt="t" />,
    );
    expect(screen.queryByRole("button", { name: /save as draft/i })).not.toBeInTheDocument();
  });

  it("AI-only Accept (no other unsaved edits): the form is clean afterward, so Publish Selected never triggers a redundant generic Product PUT", async () => {
    const user = userEvent.setup();
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockImplementation(async (_id: string, channel: any) => {
      if (channel === "etsy") {
        return {
          id: "prep-1", productId: "p1", channel: "etsy", status: "pending", baseProductUpdatedAt: "t",
          suggestedTitle: "AI Etsy Title", providerName: "mock", promptVersion: "v1", generatedAt: "t", createdAt: "t", updatedAt: "t",
        } as any;
      }
      throw new ApiError("Not found", 404);
    });
    const approvedProduct = baseProduct({ updatedAt: "2026-02-01T00:00:00.000Z", etsyTitle: "AI Etsy Title" });
    vi.spyOn(publishingLib.marketplacePreparationApi, "approve").mockResolvedValue(approvedProduct as any);
    const onSaveForPublish = vi.fn();
    const executeBatchSpy = vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch").mockResolvedValue({ productId: "p1", results: [] } as any);
    mockProductFormGets(approvedProduct);

    render(
      <ProductForm
        initialValues={productToFormValues(baseProduct())}
        submitLabel="Save Changes"
        onSubmit={vi.fn()}
        productId="p1"
        productUpdatedAt="t"
        onSaveForPublish={onSaveForPublish}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Accept AI Suggestions" }));
    await waitFor(() => expect(publishingLib.marketplacePreparationApi.approve).toHaveBeenCalled());

    await user.click(screen.getByRole("checkbox", { name: "Etsy" }));
    await user.click(screen.getByRole("button", { name: "Publish Selected" }));
    await waitFor(() => expect(executeBatchSpy).toHaveBeenCalledWith("p1", ["etsy"], "2026-02-01T00:00:00.000Z"));
    expect(onSaveForPublish).not.toHaveBeenCalled(); // no redundant Save - the AI Approve already persisted this field
  });

  it("AI Accept while an unrelated manual edit (Brand) is already dirty: the unrelated edit remains dirty, and Publish Selected performs a Save carrying it", async () => {
    const user = userEvent.setup();
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockImplementation(async (_id: string, channel: any) => {
      if (channel === "ebay") {
        return {
          id: "prep-ebay", productId: "p1", channel: "ebay", status: "pending", baseProductUpdatedAt: "t",
          suggestedTitle: "AI Ebay Title", providerName: "mock", promptVersion: "v1", generatedAt: "t", createdAt: "t", updatedAt: "t",
        } as any;
      }
      throw new ApiError("Not found", 404);
    });
    const approvedProduct = baseProduct({ updatedAt: "2026-02-01T00:00:00.000Z", ebayTitle: "AI Ebay Title" });
    vi.spyOn(publishingLib.marketplacePreparationApi, "approve").mockResolvedValue(approvedProduct as any);
    const savedProduct = baseProduct({ updatedAt: "2026-02-02T00:00:00.000Z", ebayTitle: "AI Ebay Title", brand: "Acme" });
    const onSaveForPublish = vi.fn().mockResolvedValue(savedProduct);
    const executeBatchSpy = vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch").mockResolvedValue({ productId: "p1", results: [] } as any);
    mockProductFormGets(savedProduct);

    render(
      <ProductForm
        initialValues={productToFormValues(baseProduct())}
        submitLabel="Save Changes"
        onSubmit={vi.fn()}
        productId="p1"
        productUpdatedAt="t"
        onSaveForPublish={onSaveForPublish}
      />,
    );

    await user.clear(screen.getByLabelText("Brand"));
    await user.type(screen.getByLabelText("Brand"), "Acme");
    await user.click(await screen.findByRole("button", { name: "Accept AI Suggestions" }));
    await waitFor(() => expect(publishingLib.marketplacePreparationApi.approve).toHaveBeenCalled());

    await user.click(screen.getByRole("checkbox", { name: "eBay" }));
    await user.click(screen.getByRole("button", { name: "Publish Selected" }));
    await waitFor(() => expect(onSaveForPublish).toHaveBeenCalledTimes(1));
    expect(onSaveForPublish.mock.calls[0][0]).toMatchObject({ brand: "Acme" });
    await waitFor(() => expect(executeBatchSpy).toHaveBeenCalledWith("p1", ["ebay"], "2026-02-02T00:00:00.000Z"));
  });

  it("a PRODUCT_VERSION_CONFLICT during Save-before-Publish preserves local unsaved values, offers Reload Latest Product, and never calls executePublishBatch", async () => {
    const user = userEvent.setup();
    const onSaveForPublish = vi.fn().mockRejectedValue(
      new ApiError("This product changed after you opened it. Reload the latest version before saving again.", 409, undefined, "PRODUCT_VERSION_CONFLICT"),
    );
    const executeBatchSpy = vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch");

    render(
      <ProductForm
        initialValues={productToFormValues(baseProduct())}
        submitLabel="Save Changes"
        onSubmit={vi.fn()}
        productId="p1"
        productUpdatedAt="t"
        onSaveForPublish={onSaveForPublish}
        onVersionConflictReload={vi.fn()}
      />,
    );

    await user.clear(screen.getByLabelText("Brand"));
    await user.type(screen.getByLabelText("Brand"), "Unsaved Brand");
    await user.click(await screen.findByRole("checkbox", { name: "eBay" }));
    await user.click(screen.getByRole("button", { name: "Publish Selected" }));

    expect(await screen.findByText(/no local changes were written/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload Latest Product" })).toBeInTheDocument();
    expect((screen.getByLabelText("Brand") as HTMLInputElement).value).toBe("Unsaved Brand");
    expect(executeBatchSpy).not.toHaveBeenCalled();
  });

  it("Noctella Web success in the post-publish refresh locks the visible Status field to Published and advances the shared version token", async () => {
    const user = userEvent.setup();
    const onProductVersionAdvanced = vi.fn();
    vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch").mockResolvedValue({
      productId: "p1",
      results: [{ channel: "noctella_web", outcome: "succeeded", result: {} as any }],
    } as any);
    const refreshedProduct = baseProduct({ status: "published", updatedAt: "2026-03-01T00:00:00.000Z" });
    mockProductFormGets(refreshedProduct);

    render(
      <ProductForm
        initialValues={productToFormValues(baseProduct({ status: "draft" }))}
        submitLabel="Save Changes"
        onSubmit={vi.fn()}
        productId="p1"
        productUpdatedAt="t"
        onProductVersionAdvanced={onProductVersionAdvanced}
      />,
    );

    await user.click(await screen.findByRole("checkbox", { name: "Noctella Web" }));
    await user.click(screen.getByRole("button", { name: "Publish Selected" }));

    await waitFor(() => expect(onProductVersionAdvanced).toHaveBeenCalledWith("2026-03-01T00:00:00.000Z"));
    // The Status field is now the locked, read-only Published display - never an editable dropdown.
    expect(screen.queryByRole("combobox", { name: "Status" })).not.toBeInTheDocument();
    const statusInput = await screen.findByLabelText("Status");
    expect(statusInput).toBeDisabled();
    expect((statusInput as HTMLInputElement).value).toBe("published");
  });

  it("an eBay-only publish (Noctella Web not selected) never fabricates Published in the refreshed form", async () => {
    const user = userEvent.setup();
    vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch").mockResolvedValue({
      productId: "p1",
      results: [{ channel: "ebay", outcome: "succeeded", result: {} as any }],
    } as any);
    const refreshedProduct = baseProduct({ status: "draft", updatedAt: "2026-03-02T00:00:00.000Z" });
    mockProductFormGets(refreshedProduct);

    render(
      <ProductForm
        initialValues={productToFormValues(baseProduct({ status: "draft" }))}
        submitLabel="Save Changes"
        onSubmit={vi.fn()}
        productId="p1"
        productUpdatedAt="t"
      />,
    );

    await user.click(await screen.findByRole("checkbox", { name: "eBay" }));
    await user.click(screen.getByRole("button", { name: "Publish Selected" }));

    await waitFor(() => expect(apiLib.api.get).toHaveBeenCalledWith("/api/products/p1"));
    // Status remains the ordinary editable dropdown, still showing draft - never silently promoted to Published.
    const statusSelect = await screen.findByRole("combobox", { name: "Status" });
    expect((statusSelect as HTMLSelectElement).value).toBe("draft");
  });
});

/**
 * Sprint 147: visible label polish only - the persisted woo* fields/schema/API contract are
 * completely unchanged (see the unaffected Sprint 137/145/146 tests above, which still exercise
 * the exact same fields under their exact same names); only the Section title text changed.
 */
describe("ProductForm — Sprint 147: Noctella Web section label", () => {
  it("the visible section title is 'Noctella Web (optional — not published or synced yet)'", () => {
    render(<ProductForm initialValues={emptyProductForm} submitLabel="Create" onSubmit={vi.fn()} />);
    expect(screen.getByText("Noctella Web (optional — not published or synced yet)")).toBeInTheDocument();
  });

  it("the old 'WooCommerce (optional — not published or synced yet)' title is gone", () => {
    render(<ProductForm initialValues={emptyProductForm} submitLabel="Create" onSubmit={vi.fn()} />);
    expect(screen.queryByText("WooCommerce (optional — not published or synced yet)")).not.toBeInTheDocument();
  });
});
