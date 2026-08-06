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

describe("ApplyAndFinalizeSection (Sprint 97)", () => {
  it("Save as Draft requires explicit confirmation and submits the exact canonical payload", async () => {
    const user = userEvent.setup();
    mockCategories();
    const spy = vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "saveAsDraft").mockResolvedValue({} as any);
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
    await user.type(screen.getByPlaceholderText("SKU"), "SKU-1");
    await user.selectOptions(screen.getByDisplayValue("Select category"), "cat-1");
    await user.type(screen.getByPlaceholderText("Price (EUR)"), "10");
    await user.click(screen.getByRole("button", { name: "Save as Draft" }));
    expect(spy).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm Save as Draft" }));
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith("intake-1", {
        sku: "SKU-1",
        categoryId: "cat-1",
        type: "unique_item",
        priceEur: 10,
        stockQuantity: undefined,
        expectedProposalUpdatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
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
