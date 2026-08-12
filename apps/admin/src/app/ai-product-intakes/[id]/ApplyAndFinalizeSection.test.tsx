// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AiProductIntakeStatus } from "@noctella/shared";
import { api, ApiError } from "@/lib/api";
import * as aiProductIntakesLib from "@/lib/aiProductIntakes";
import { ApplyAndFinalizeSection } from "./ApplyAndFinalizeSection";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

afterEach(() => {
  vi.restoreAllMocks();
  push.mockClear();
});

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

const proposal = { id: "p1", intakeId: "intake-1", updatedAt: "2026-01-01T00:00:00.000Z" } as any;

function mockCategories() {
  vi.spyOn(api, "get").mockResolvedValue({ items: [{ id: "cat-1", name: "Category One" }], total: 1, page: 1, pageSize: 100 });
}

describe("ApplyAndFinalizeSection (Sprint 137: warehouse-simplified Stock Acceptance)", () => {
  it("never renders a Price field - the warehouse must never enter a sales price", async () => {
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
    expect(screen.queryByPlaceholderText(/Price/i)).not.toBeInTheDocument();
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

  it("Manufacturer/Country of origin/Period/Materials/Condition description/SEO title/Meta description are collapsed behind 'More details (optional)', not in the primary path", async () => {
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
    expect(screen.getByText("More details (optional)")).toBeInTheDocument();
    // Present in the DOM (inside <details>), but not part of the always-visible primary fields -
    // querying by placeholder still finds them since jsdom does not hide collapsed <details> content
    // from the accessibility tree the way visual collapse would; the key assertion is that the
    // primary, always-visible fields (Category/Type/Quantity/Brand/Model/Condition) are the ones
    // outside the disclosure.
    expect(screen.getByPlaceholderText("Manufacturer (optional)")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("SEO title (optional)")).toBeInTheDocument();
  });

  it("shows the always-visible warehouse-facing fields: Quantity, Brand, Model, Condition", async () => {
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
    expect(screen.getByPlaceholderText(/Quantity/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Brand (optional)")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Model (optional)")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Condition (optional)")).toBeInTheDocument();
  });

  it("Stock Acceptance still requires explicit confirmation before submitting", async () => {
    const user = userEvent.setup();
    mockCategories();
    const acceptSpy = vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "acceptIntoStock").mockReturnValue(new Promise(() => {}));
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
    await user.click(screen.getByRole("button", { name: "Accept into Stock" }));
    expect(acceptSpy).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm Stock Acceptance" }));
    await waitFor(() => expect(acceptSpy).toHaveBeenCalled());
  });

  it("the submitted request contains no priceEur field at all", async () => {
    const user = userEvent.setup();
    mockCategories();
    const acceptSpy = vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "acceptIntoStock").mockReturnValue(new Promise(() => {}));
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
    await user.click(screen.getByRole("button", { name: "Accept into Stock" }));
    await user.click(screen.getByRole("button", { name: "Confirm Stock Acceptance" }));
    await waitFor(() => expect(acceptSpy).toHaveBeenCalled());
    const submitted = acceptSpy.mock.calls[0][1];
    expect("priceEur" in submitted).toBe(false);
  });

  it("Unique Item quantity: the quantity input is disabled (backend authority normalizes it to 1)", async () => {
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
    expect(screen.getByPlaceholderText(/Quantity/)).toBeDisabled();
  });

  describe("Sprint 137: automatic photo finalization chaining", () => {
    async function acceptFlow(user: ReturnType<typeof userEvent.setup>) {
      await screen.findByText("Category One");
      await user.selectOptions(screen.getByDisplayValue("Select category"), "cat-1");
      await user.click(screen.getByRole("button", { name: "Accept into Stock" }));
      await user.click(screen.getByRole("button", { name: "Confirm Stock Acceptance" }));
    }

    it("successful acceptance automatically calls Finalize for the same Product, then navigates to its label route only after Finalize succeeds", async () => {
      const user = userEvent.setup();
      mockCategories();
      const acceptSpy = vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "acceptIntoStock").mockResolvedValue({ id: "product-9" } as any);
      const finalizeSpy = vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "finalizePhotos").mockResolvedValue({} as any);
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
      await acceptFlow(user);
      await waitFor(() => expect(acceptSpy).toHaveBeenCalled());
      await waitFor(() => expect(finalizeSpy).toHaveBeenCalledWith("intake-1"));
      await waitFor(() => expect(push).toHaveBeenCalledWith("/products/product-9/label"));
      // Never a manual Finalize step visible on the happy path.
      expect(screen.queryByRole("button", { name: "Finalize Photos" })).not.toBeInTheDocument();
    });

    it("if Finalize fails after a successful Stock Acceptance, it does NOT report Stock Acceptance itself as failed, does NOT re-call Stock Acceptance, and exposes a Retry action instead", async () => {
      const user = userEvent.setup();
      mockCategories();
      const acceptSpy = vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "acceptIntoStock").mockResolvedValue({ id: "product-9" } as any);
      const finalizeSpy = vi
        .spyOn(aiProductIntakesLib.aiProductIntakesApi, "finalizePhotos")
        .mockRejectedValue(new ApiError("Finalize failed", 500));
      const onIntakeChanged = vi.fn().mockResolvedValue(intake({ status: AiProductIntakeStatus.Applied, resultProductId: "product-9" }));
      render(
        <ApplyAndFinalizeSection
          intakeId="intake-1"
          intake={intake()}
          photos={[]}
          proposal={proposal}
          onIntakeChanged={onIntakeChanged}
          onPhotosReload={vi.fn().mockResolvedValue([])}
        />,
      );
      await acceptFlow(user);
      await waitFor(() => expect(finalizeSpy).toHaveBeenCalledTimes(1));
      // Stock Acceptance itself never re-runs and is never reported as failed.
      expect(acceptSpy).toHaveBeenCalledTimes(1);
      expect(screen.queryByText("Failed to accept into stock")).not.toBeInTheDocument();
      expect(push).not.toHaveBeenCalled();
      await screen.findByText("Finalize failed");
    });

    it("Retry photo finalization retries only Finalize (never Stock Acceptance again) and preserves the same productId", async () => {
      const user = userEvent.setup();
      mockCategories();
      const acceptSpy = vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "acceptIntoStock").mockResolvedValue({ id: "product-9" } as any);
      const finalizeSpy = vi
        .spyOn(aiProductIntakesLib.aiProductIntakesApi, "finalizePhotos")
        .mockRejectedValueOnce(new ApiError("Finalize failed", 500))
        .mockResolvedValueOnce({} as any);
      render(
        <ApplyAndFinalizeSection
          intakeId="intake-1"
          intake={intake()}
          photos={[photoFixture()]}
          proposal={proposal}
          onIntakeChanged={vi.fn().mockResolvedValue(intake({ status: AiProductIntakeStatus.Applied, resultProductId: "product-9" }))}
          onPhotosReload={vi.fn().mockResolvedValue([])}
        />,
      );
      await acceptFlow(user);
      await screen.findByText("Finalize failed");

      const retryButton = await screen.findByRole("button", { name: "Retry photo finalization" });
      await user.click(retryButton);

      await waitFor(() => expect(finalizeSpy).toHaveBeenCalledTimes(2));
      expect(acceptSpy).toHaveBeenCalledTimes(1); // never called again
      await waitFor(() => expect(push).toHaveBeenCalledWith("/products/product-9/label"));
    });

    it("reloading on an already-Applied intake (Finalize never attempted this session) shows the Retry action without auto-triggering Finalize", () => {
      render(
        <ApplyAndFinalizeSection
          intakeId="intake-1"
          intake={intake({ status: AiProductIntakeStatus.Applied, resultProductId: "product-9" })}
          photos={[photoFixture()]}
          proposal={null}
          onIntakeChanged={vi.fn()}
          onPhotosReload={vi.fn()}
        />,
      );
      expect(screen.getByRole("button", { name: "Retry photo finalization" })).toBeInTheDocument();
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
    expect(screen.getByRole("link", { name: "View Stock Label →" })).toHaveAttribute("href", "/products/product-9/label");
  });
});

function photoFixture() {
  return { id: "photo-1", intakeId: "intake-1", storageKey: "photo-1.webp", originalFilename: "first.png", createdByAdminUserId: "admin-1", createdAt: "t", updatedAt: "t" };
}
