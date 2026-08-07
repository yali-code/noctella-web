// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AiProductIntakeStatus } from "@noctella/shared";
import { api, ApiError } from "@/lib/api";
import * as aiProductIntakesLib from "@/lib/aiProductIntakes";
import { ApplyAndFinalizeSection } from "./ApplyAndFinalizeSection";

afterEach(() => vi.restoreAllMocks());

function intake(overrides: Record<string, unknown> = {}) {
  return {
    id: "intake-1",
    status: AiProductIntakeStatus.Open,
    createdByAdminUserId: "admin-1",
    createdAt: "t",
    updatedAt: "t",
    ...overrides,
  } as any;
}

function photo(id: string, filename: string) {
  return { id, intakeId: "intake-1", storageKey: `${id}.webp`, originalFilename: filename, createdByAdminUserId: "admin-1", createdAt: "t", updatedAt: "t" };
}

const proposal = { id: "p1", intakeId: "intake-1", updatedAt: "2026-01-01T00:00:00.000Z" } as any;

function mockCategories() {
  vi.spyOn(api, "get").mockResolvedValue({ items: [{ id: "cat-1", name: "Category One" }], total: 1, page: 1, pageSize: 100 });
}

describe("ApplyAndFinalizeSection (Sprint 97/106)", () => {
  it("Stock Acceptance requires explicit confirmation, submits no sku, and includes only the entered optional fields", async () => {
    const user = userEvent.setup();
    mockCategories();
    const spy = vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "acceptIntoStock").mockResolvedValue({} as any);
    render(
      <ApplyAndFinalizeSection
        intakeId="intake-1"
        intake={intake()}
        photos={[]}
        proposal={proposal}
        onIntakeChanged={vi.fn().mockResolvedValue(intake())}
        onPhotosReload={vi.fn().mockResolvedValue([])}
      />,
    );
    await screen.findByText("Category One");
    await user.selectOptions(screen.getByDisplayValue("Select category"), "cat-1");
    await user.type(screen.getByPlaceholderText("Price (EUR)"), "10");
    await user.click(screen.getByRole("button", { name: "Accept into Stock" }));
    expect(spy).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm Stock Acceptance" }));
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith("intake-1", {
        categoryId: "cat-1",
        type: "unique_item",
        priceEur: 10,
        stockQuantity: undefined,
        brand: undefined,
        model: undefined,
        manufacturer: undefined,
        countryOfOrigin: undefined,
        period: undefined,
        materials: undefined,
        condition: undefined,
        conditionDescription: undefined,
        seoTitle: undefined,
        metaDescription: undefined,
        expectedProposalUpdatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
  });

  it("never renders a SKU input - SKU is always system-generated", async () => {
    mockCategories();
    render(
      <ApplyAndFinalizeSection
        intakeId="intake-1"
        intake={intake()}
        photos={[]}
        proposal={proposal}
        onIntakeChanged={vi.fn().mockResolvedValue(intake())}
        onPhotosReload={vi.fn().mockResolvedValue([])}
      />,
    );
    await screen.findByText("Category One");
    expect(screen.queryByPlaceholderText("SKU")).not.toBeInTheDocument();
  });

  it("pre-fills optional fields from the proposal's AI suggestions, editable before submission", async () => {
    const user = userEvent.setup();
    mockCategories();
    const spy = vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "acceptIntoStock").mockResolvedValue({} as any);
    const suggestedProposal = {
      ...proposal,
      suggestedCategoryId: "cat-1",
      suggestedPriceEur: 42,
      suggestedBrand: "Acme",
      suggestedModel: "Model X",
      suggestedManufacturer: "Acme Corp",
      suggestedCountryOfOrigin: "Germany",
      suggestedPeriod: "1920s",
      suggestedMaterials: "Oak",
      suggestedCondition: "Good",
      suggestedConditionDescription: "Minor wear",
      suggestedSeoTitle: "Antique Oak Item",
      suggestedMetaDescription: "A fine antique item.",
    };
    render(
      <ApplyAndFinalizeSection
        intakeId="intake-1"
        intake={intake()}
        photos={[]}
        proposal={suggestedProposal}
        onIntakeChanged={vi.fn().mockResolvedValue(intake())}
        onPhotosReload={vi.fn().mockResolvedValue([])}
      />,
    );
    await screen.findByText("Category One");
    expect(screen.getByDisplayValue("Acme")).toBeInTheDocument();
    expect(screen.getByDisplayValue("42")).toBeInTheDocument();
    // The admin can override an AI-suggested value before confirming.
    const brandInput = screen.getByPlaceholderText("Brand (optional)");
    await user.clear(brandInput);
    await user.type(brandInput, "Overridden Brand");
    await user.click(screen.getByRole("button", { name: "Accept into Stock" }));
    await user.click(screen.getByRole("button", { name: "Confirm Stock Acceptance" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("intake-1", expect.objectContaining({ brand: "Overridden Brand", model: "Model X" })));
  });

  it("Primary selection initializes to the first ordered staged photo and allows reselection", async () => {
    mockCategories();
    const user = userEvent.setup();
    render(
      <ApplyAndFinalizeSection
        intakeId="intake-1"
        intake={intake({ status: AiProductIntakeStatus.Applied, appliedAt: "t" })}
        photos={[photo("photo-1", "first.png"), photo("photo-2", "second.png")]}
        proposal={null}
        onIntakeChanged={vi.fn().mockResolvedValue(intake())}
        onPhotosReload={vi.fn().mockResolvedValue([])}
      />,
    );
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios[0].checked).toBe(true);
    await user.click(radios[1]);
    expect(radios[1].checked).toBe(true);
  });

  it("if the selected photo is removed by a refresh, the first remaining photo becomes selected", () => {
    const { rerender } = render(
      <ApplyAndFinalizeSection
        intakeId="intake-1"
        intake={intake({ status: AiProductIntakeStatus.Applied, appliedAt: "t" })}
        photos={[photo("photo-1", "first.png"), photo("photo-2", "second.png")]}
        proposal={null}
        onIntakeChanged={vi.fn()}
        onPhotosReload={vi.fn()}
      />,
    );
    rerender(
      <ApplyAndFinalizeSection
        intakeId="intake-1"
        intake={intake({ status: AiProductIntakeStatus.Applied, appliedAt: "t" })}
        photos={[photo("photo-2", "second.png")]}
        proposal={null}
        onIntakeChanged={vi.fn()}
        onPhotosReload={vi.fn()}
      />,
    );
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios[0].checked).toBe(true);
  });

  it("Finalize is disabled until a Primary is selected, requires confirmation, and always sends an explicit primaryIntakePhotoId", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "finalizePhotos").mockResolvedValue({} as any);
    render(
      <ApplyAndFinalizeSection
        intakeId="intake-1"
        intake={intake({ status: AiProductIntakeStatus.Applied, appliedAt: "t" })}
        photos={[photo("photo-1", "first.png")]}
        proposal={null}
        onIntakeChanged={vi.fn().mockResolvedValue(intake())}
        onPhotosReload={vi.fn().mockResolvedValue([])}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Finalize Photos" }));
    expect(spy).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm Finalize" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("intake-1", "photo-1"));
  });

  it("shows a conflict error without automatically retrying Finalize", async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(aiProductIntakesLib.aiProductIntakesApi, "finalizePhotos")
      .mockRejectedValue(new ApiError("This intake is not Applied.", 409, undefined, "AI_INTAKE_PHOTO_FINALIZATION_NOT_APPLIED"));
    render(
      <ApplyAndFinalizeSection
        intakeId="intake-1"
        intake={intake({ status: AiProductIntakeStatus.Applied, appliedAt: "t" })}
        photos={[photo("photo-1", "first.png")]}
        proposal={null}
        onIntakeChanged={vi.fn().mockResolvedValue(intake())}
        onPhotosReload={vi.fn().mockResolvedValue([])}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Finalize Photos" }));
    await user.click(screen.getByRole("button", { name: "Confirm Finalize" }));
    await screen.findByText("This intake is not Applied.");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  describe("Sprint 99: client-side price/stock validation", () => {
    async function renderAndOpenConfirm(user: ReturnType<typeof userEvent.setup>) {
      mockCategories();
      const spy = vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "acceptIntoStock").mockResolvedValue({} as any);
      render(
        <ApplyAndFinalizeSection
          intakeId="intake-1"
          intake={intake()}
          photos={[]}
          proposal={proposal}
          onIntakeChanged={vi.fn().mockResolvedValue(intake())}
          onPhotosReload={vi.fn().mockResolvedValue([])}
        />,
      );
      await screen.findByText("Category One");
      await user.selectOptions(screen.getByDisplayValue("Select category"), "cat-1");
      return spy;
    }

    it("missing price blocks submission", async () => {
      const user = userEvent.setup();
      const spy = await renderAndOpenConfirm(user);
      // Price left empty - the Confirm button is unreachable, matching the pre-existing disabled contract.
      expect(screen.getByRole("button", { name: "Accept into Stock" })).not.toBeDisabled();
      await user.click(screen.getByRole("button", { name: "Accept into Stock" }));
      expect(screen.getByRole("button", { name: "Confirm Stock Acceptance" })).toBeDisabled();
      expect(spy).not.toHaveBeenCalled();
    });

    it("non-numeric price blocks submission", async () => {
      const user = userEvent.setup();
      const spy = await renderAndOpenConfirm(user);
      await user.type(screen.getByPlaceholderText("Price (EUR)"), "abc");
      await user.click(screen.getByRole("button", { name: "Accept into Stock" }));
      await user.click(screen.getByRole("button", { name: "Confirm Stock Acceptance" }));
      await screen.findByText("Price (EUR) must be a number greater than or equal to 0.");
      expect(spy).not.toHaveBeenCalled();
    });

    it("negative price blocks submission", async () => {
      const user = userEvent.setup();
      const spy = await renderAndOpenConfirm(user);
      await user.type(screen.getByPlaceholderText("Price (EUR)"), "-5");
      await user.click(screen.getByRole("button", { name: "Accept into Stock" }));
      await user.click(screen.getByRole("button", { name: "Confirm Stock Acceptance" }));
      await screen.findByText("Price (EUR) must be a number greater than or equal to 0.");
      expect(spy).not.toHaveBeenCalled();
    });

    it("non-numeric stock blocks submission", async () => {
      const user = userEvent.setup();
      const spy = await renderAndOpenConfirm(user);
      await user.type(screen.getByPlaceholderText("Price (EUR)"), "10");
      await user.type(screen.getByPlaceholderText("Stock quantity (optional)"), "abc");
      await user.click(screen.getByRole("button", { name: "Accept into Stock" }));
      await user.click(screen.getByRole("button", { name: "Confirm Stock Acceptance" }));
      await screen.findByText("Stock quantity must be a whole number greater than or equal to 0.");
      expect(spy).not.toHaveBeenCalled();
    });

    it("fractional stock blocks submission", async () => {
      const user = userEvent.setup();
      const spy = await renderAndOpenConfirm(user);
      await user.type(screen.getByPlaceholderText("Price (EUR)"), "10");
      await user.type(screen.getByPlaceholderText("Stock quantity (optional)"), "1.5");
      await user.click(screen.getByRole("button", { name: "Accept into Stock" }));
      await user.click(screen.getByRole("button", { name: "Confirm Stock Acceptance" }));
      await screen.findByText("Stock quantity must be a whole number greater than or equal to 0.");
      expect(spy).not.toHaveBeenCalled();
    });

    it("negative stock blocks submission", async () => {
      const user = userEvent.setup();
      const spy = await renderAndOpenConfirm(user);
      await user.type(screen.getByPlaceholderText("Price (EUR)"), "10");
      await user.type(screen.getByPlaceholderText("Stock quantity (optional)"), "-1");
      await user.click(screen.getByRole("button", { name: "Accept into Stock" }));
      await user.click(screen.getByRole("button", { name: "Confirm Stock Acceptance" }));
      await screen.findByText("Stock quantity must be a whole number greater than or equal to 0.");
      expect(spy).not.toHaveBeenCalled();
    });

    it("valid zero price and zero stock are accepted and reach the API unchanged", async () => {
      const user = userEvent.setup();
      const spy = await renderAndOpenConfirm(user);
      await user.type(screen.getByPlaceholderText("Price (EUR)"), "0");
      await user.type(screen.getByPlaceholderText("Stock quantity (optional)"), "0");
      await user.click(screen.getByRole("button", { name: "Accept into Stock" }));
      await user.click(screen.getByRole("button", { name: "Confirm Stock Acceptance" }));
      await waitFor(() =>
        expect(spy).toHaveBeenCalledWith(
          "intake-1",
          expect.objectContaining({
            categoryId: "cat-1",
            type: "unique_item",
            priceEur: 0,
            stockQuantity: 0,
            expectedProposalUpdatedAt: "2026-01-01T00:00:00.000Z",
          }),
        ),
      );
    });
  });

  it("shows the Product link once resultProductId is present", () => {
    render(
      <ApplyAndFinalizeSection
        intakeId="intake-1"
        intake={intake({ status: AiProductIntakeStatus.Finalized, finalizedAt: "t", resultProductId: "product-9" })}
        photos={[]}
        proposal={null}
        onIntakeChanged={vi.fn()}
        onPhotosReload={vi.fn()}
      />,
    );
    expect(screen.getByRole("link", { name: "View Product →" })).toHaveAttribute("href", "/products/product-9");
  });
});
