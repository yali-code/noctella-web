// @vitest-environment jsdom
// Sprint 88 (ADR-017): proves ProductForm's PRODUCT_VERSION_CONFLICT handling - values are
// preserved, no automatic reload/resubmit occurs, and the reload callback fires only on an
// explicit user click - without disturbing the existing ordinary ApiError.details field-error
// behavior. Follows the jsdom/testing-library conventions established by app/offers/page.test.tsx.
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/api";
import { ProductForm, emptyProductForm } from "./ProductForm";

afterEach(() => vi.restoreAllMocks());

function baseValues() {
  return { ...emptyProductForm, sku: "SKU-1", title: "Original Title", priceEur: "100", categoryId: "cat-1" };
}

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
