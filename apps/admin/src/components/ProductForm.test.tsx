// @vitest-environment jsdom
// Sprint 88 (ADR-017): proves ProductForm's PRODUCT_VERSION_CONFLICT handling - values are
// preserved, no automatic reload/resubmit occurs, and the reload callback fires only on an
// explicit user click - without disturbing the existing ordinary ApiError.details field-error
// behavior. Follows the jsdom/testing-library conventions established by app/offers/page.test.tsx.
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/api";
import { ProductForm, emptyProductForm, productToFormValues } from "./ProductForm";

afterEach(() => vi.restoreAllMocks());

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
  // "Listing Price (EUR)" is used identically by the eBay, Etsy, and WooCommerce sections (in that
  // render order); only the WooCommerce one (index 2) participates in the approved Noctella Web
  // effective-price invariant, so tests targeting it disambiguate via getAllByLabelText.
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
