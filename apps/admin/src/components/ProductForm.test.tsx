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
import {productLifecycleApi}from"@/lib/productLifecycle";
import{ProductStatus}from"@noctella/shared";
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
describe("ProductForm final lifecycle integration",()=>{
 it("keeps dirty values and disables Publish immediately after Pause even when refresh fails",async()=>{const user=userEvent.setup(),state=vi.spyOn(productLifecycleApi,"state");state.mockResolvedValueOnce({productId:"p1",productStatus:ProductStatus.Draft,productUpdatedAt:"v1",hasActiveExternalListings:false}).mockRejectedValueOnce(new Error("refresh failed"));vi.spyOn(productLifecycleApi,"archiveSafety").mockResolvedValue({canArchive:true});vi.spyOn(productLifecycleApi,"pause").mockResolvedValue({operation:{id:"o",productId:"p1",action:"pause",status:"partially_failed",previousProductStatus:ProductStatus.Draft,targetSnapshot:[],targetResults:[],actorAdminUserId:"a",idempotencyKey:"k",createdAt:"t",updatedAt:"t"},productUpdatedAtBefore:"v1",productUpdatedAtAfter:"v2"});const submit=vi.fn();render(<ProductForm initialValues={baseValues()} submitLabel="Save Changes" onSubmit={submit} productId="p1" productUpdatedAt="v1"/>);const title=screen.getAllByLabelText("Title")[0];await user.clear(title);await user.type(title,"Unsaved");await user.click(await screen.findByRole("button",{name:"Pause"}));await user.click(screen.getByRole("button",{name:"Pause Now"}));expect(await screen.findByRole("button",{name:"Paused"})).toBeDisabled();expect(screen.getByDisplayValue("Unsaved")).toBeInTheDocument();expect(screen.getByRole("button",{name:"Publish Selected"})).toBeDisabled();expect(screen.getByText("This Product is paused. Use Relist to restore its previously active channels.")).toBeInTheDocument();expect(submit).not.toHaveBeenCalled()});
 it("applies canonical Archived Product to parent-owned persisted state",async()=>{const user=userEvent.setup();vi.spyOn(productLifecycleApi,"state").mockResolvedValue({productId:"p1",productStatus:ProductStatus.Draft,productUpdatedAt:"v1",hasActiveExternalListings:false});vi.spyOn(productLifecycleApi,"archiveSafety").mockResolvedValue({canArchive:true});vi.spyOn(productLifecycleApi,"archive").mockResolvedValue(baseProduct({status:"archived",updatedAt:"v2"}));render(<ProductForm initialValues={baseValues()} submitLabel="Save Changes" onSubmit={vi.fn()} productId="p1" productUpdatedAt="v1"/>);await user.click(await screen.findByRole("button",{name:"Archive"}));await user.click(screen.getAllByRole("button",{name:"Archive"})[0]);expect(await screen.findByRole("button",{name:"Archived"})).toBeDisabled();expect(screen.getByRole("button",{name:"Pause"})).toBeDisabled();expect(screen.getByRole("button",{name:"Relist"})).toBeDisabled();expect(screen.queryByRole("button",{name:/restore|delete/i})).not.toBeInTheDocument()});
 it("create mode makes no lifecycle reads",()=>{const state=vi.spyOn(productLifecycleApi,"state"),safety=vi.spyOn(productLifecycleApi,"archiveSafety");render(<ProductForm initialValues={emptyProductForm} submitLabel="Create Product" onSubmit={vi.fn()}/>);expect(screen.queryByTestId("product-lifecycle-actions")).not.toBeInTheDocument();expect(state).not.toHaveBeenCalled();expect(safety).not.toHaveBeenCalled()});
});

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

  it("offers the approved conditions and keeps a previously saved value selected", () => {
    render(
      <ProductForm
        initialValues={productToFormValues(baseProduct({ condition: "Good vintage" }))}
        onSubmit={vi.fn()}
        submitLabel="Save"
      />,
    );
    const select = screen.getByLabelText("Condition") as HTMLSelectElement;
    expect(select.value).toBe("Good vintage");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Select condition", "Good vintage", "Used", "For parts", "Unused", "New old stock"]);
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

describe("ProductForm — single AI fill", () => {
  it("create mode never mounts the AI fill", () => {
    render(<ProductForm initialValues={emptyProductForm} submitLabel="Create" onSubmit={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Fill all fields with AI" })).not.toBeInTheDocument();
  });
});

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
