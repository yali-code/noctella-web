// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api, ApiError } from "@/lib/api";
import ShippingMethodsPage from "./page";

afterEach(() => vi.restoreAllMocks());

function method(overrides: Record<string, unknown> = {}) {
  return {
    id: "method-1",
    label: "Standard",
    isActive: true,
    sortOrder: 0,
    ruleType: "FlatRate",
    flatAmountEurCents: 500,
    freeThresholdEurCents: null,
    countryCodes: null,
    shippingProfiles: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("Sprint 134 correction: Admin Shipping Methods page", () => {
  it("1. loads and renders the list from the API", async () => {
    vi.spyOn(api, "get").mockResolvedValue({ items: [method({ label: "Free Shipping" })] });
    render(<ShippingMethodsPage />);
    await screen.findByText("Free Shipping");
  });

  it("2. creates a FREE configuration without requiring a flat amount", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "get").mockResolvedValue({ items: [] });
    const postSpy = vi.spyOn(api, "post").mockResolvedValue(method());
    render(<ShippingMethodsPage />);
    await screen.findByText("No shipping methods configured yet.");

    await user.type(screen.getByLabelText("Label"), "Free Shipping");
    await user.selectOptions(screen.getByLabelText("Rule Type"), "Free");
    await user.click(screen.getByRole("button", { name: "Create Shipping Method" }));

    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));
    const [, payload] = postSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.ruleType).toBe("Free");
    expect(payload.flatAmountEurCents).toBeUndefined();
    expect(payload.freeThresholdEurCents).toBeUndefined();
  });

  it("3. FLAT_RATE converts EUR input to integer cents deterministically", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "get").mockResolvedValue({ items: [] });
    const postSpy = vi.spyOn(api, "post").mockResolvedValue(method());
    render(<ShippingMethodsPage />);
    await screen.findByText("No shipping methods configured yet.");

    await user.type(screen.getByLabelText("Label"), "Standard");
    await user.selectOptions(screen.getByLabelText("Rule Type"), "FlatRate");
    await user.type(screen.getByLabelText("Flat Amount (EUR)"), "9.90");
    await user.click(screen.getByRole("button", { name: "Create Shipping Method" }));

    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));
    const [, payload] = postSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.flatAmountEurCents).toBe(990);
  });

  it("4. FREE_OVER_SUBTOTAL sends both the base flat amount and the threshold in cents", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "get").mockResolvedValue({ items: [] });
    const postSpy = vi.spyOn(api, "post").mockResolvedValue(method());
    render(<ShippingMethodsPage />);
    await screen.findByText("No shipping methods configured yet.");

    await user.type(screen.getByLabelText("Label"), "Free Over 100");
    await user.selectOptions(screen.getByLabelText("Rule Type"), "FreeOverSubtotal");
    await user.type(screen.getByLabelText("Flat Amount Below Threshold (EUR)"), "5.00");
    await user.type(screen.getByLabelText("Free-Shipping Threshold (EUR subtotal)"), "100.00");
    await user.click(screen.getByRole("button", { name: "Create Shipping Method" }));

    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));
    const [, payload] = postSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.flatAmountEurCents).toBe(500);
    expect(payload.freeThresholdEurCents).toBe(10000);
  });

  it("5. country scope sends normalized, uppercased, trimmed country codes", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "get").mockResolvedValue({ items: [] });
    const postSpy = vi.spyOn(api, "post").mockResolvedValue(method());
    render(<ShippingMethodsPage />);
    await screen.findByText("No shipping methods configured yet.");

    await user.type(screen.getByLabelText("Label"), "EU Only");
    await user.type(screen.getByLabelText(/Country Eligibility/), " bg, de ,fr");
    await user.click(screen.getByRole("button", { name: "Create Shipping Method" }));

    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));
    const [, payload] = postSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.countryCodes).toEqual(["BG", "DE", "FR"]);
  });

  it("6. product-profile scope only ever sends controlled vocabulary values", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "get").mockResolvedValue({ items: [] });
    const postSpy = vi.spyOn(api, "post").mockResolvedValue(method());
    render(<ShippingMethodsPage />);
    await screen.findByText("No shipping methods configured yet.");

    await user.type(screen.getByLabelText("Label"), "Oversize Only");
    await user.click(screen.getByRole("checkbox", { name: "oversize" }));
    await user.click(screen.getByRole("button", { name: "Create Shipping Method" }));

    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));
    const [, payload] = postSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.shippingProfiles).toEqual(["oversize"]);
  });

  it("7. edit updates an existing method via PUT, not POST", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "get").mockResolvedValue({ items: [method({ id: "method-7", label: "Old Label" })] });
    const putSpy = vi.spyOn(api, "put").mockResolvedValue(method({ id: "method-7", label: "New Label" }));
    render(<ShippingMethodsPage />);
    await screen.findByText("Old Label");

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const labelInput = screen.getByLabelText("Label") as HTMLInputElement;
    await user.clear(labelInput);
    await user.type(labelInput, "New Label");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(putSpy).toHaveBeenCalledWith("/api/shipping-methods/method-7", expect.objectContaining({ label: "New Label" })));
  });

  it("8. activate/deactivate calls PUT (update), never DELETE", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "get").mockResolvedValue({ items: [method({ id: "method-8", isActive: true })] });
    const putSpy = vi.spyOn(api, "put").mockResolvedValue(method({ id: "method-8", isActive: false }));
    const deleteSpy = vi.spyOn(api, "delete");
    render(<ShippingMethodsPage />);
    await screen.findByText("Standard");

    await user.click(screen.getByRole("button", { name: "Deactivate" }));

    await waitFor(() => expect(putSpy).toHaveBeenCalledWith("/api/shipping-methods/method-8", { isActive: false }));
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("9. no delete action is exposed anywhere on the page", async () => {
    vi.spyOn(api, "get").mockResolvedValue({ items: [method()] });
    render(<ShippingMethodsPage />);
    await screen.findByText("Standard");
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
    expect(screen.queryByText(/delete/i)).toBeNull();
  });

  it("10. rule-specific required fields are enforced before submission", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "get").mockResolvedValue({ items: [] });
    const postSpy = vi.spyOn(api, "post").mockResolvedValue(method());
    render(<ShippingMethodsPage />);
    await screen.findByText("No shipping methods configured yet.");

    await user.type(screen.getByLabelText("Label"), "Incomplete Flat Rate");
    await user.selectOptions(screen.getByLabelText("Rule Type"), "FlatRate");
    // Flat amount intentionally left blank.
    await user.click(screen.getByRole("button", { name: "Create Shipping Method" }));

    await screen.findByText("A non-negative flat amount is required for this rule type");
    expect(postSpy).not.toHaveBeenCalled();
  });

  it("11. an API error is shown and never displayed as a false success", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "get").mockResolvedValue({ items: [] });
    vi.spyOn(api, "post").mockRejectedValue(new ApiError("Shipping method label already in use", 409));
    render(<ShippingMethodsPage />);
    await screen.findByText("No shipping methods configured yet.");

    await user.type(screen.getByLabelText("Label"), "Duplicate");
    await user.selectOptions(screen.getByLabelText("Rule Type"), "Free");
    await user.click(screen.getByRole("button", { name: "Create Shipping Method" }));

    await screen.findByText("Shipping method label already in use");
    // The form must not have reset to its empty/created state on failure.
    expect((screen.getByLabelText("Label") as HTMLInputElement).value).toBe("Duplicate");
  });
});
