// @vitest-environment jsdom
// Sprint 148: focused state-machine + selective-Accept tests for the canonical AI Product
// Suggestions panel, isolated from the much larger ProductForm suite - mirrors
// AiChannelSuggestionsSection.test.tsx's proven structure. ProductForm-level scoped-merge /
// unrelated-unsaved-edit-preservation integration is covered in ProductForm.test.tsx instead.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CanonicalProductProposalStatus, type CanonicalProductProposal } from "@noctella/shared";
import { ApiError } from "@/lib/api";
import * as canonicalLib from "@/lib/canonicalProductProposals";
import { CanonicalProductAiSuggestionsSection } from "./CanonicalProductAiSuggestionsSection";
import { emptyProductForm, type ProductFormValues } from "./ProductForm";

afterEach(() => vi.restoreAllMocks());

function baseProposal(overrides: Partial<CanonicalProductProposal> = {}): CanonicalProductProposal {
  return {
    id: "proposal-1",
    productId: "p1",
    status: CanonicalProductProposalStatus.Pending,
    baseProductUpdatedAt: "2026-01-01T00:00:00.000Z",
    suggestedBrand: "Omega",
    suggestedModel: "Speedmaster",
    suggestedMarketingTags: ["Father's Day"],
    providerName: "mock",
    promptVersion: "v1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function values(overrides: Partial<ProductFormValues> = {}): ProductFormValues {
  return { ...emptyProductForm, ...overrides };
}

describe("CanonicalProductAiSuggestionsSection — Sprint 148", () => {
  it("NONE state: shows a Generate action when no proposal exists (404)", async () => {
    vi.spyOn(canonicalLib.canonicalProductProposalApi, "get").mockRejectedValue(new ApiError("Not found", 404));
    render(<CanonicalProductAiSuggestionsSection productId="p1" values={values()} productUpdatedAt="2026-01-01T00:00:00.000Z" onApplied={vi.fn()} />);
    expect(await screen.findByText("No AI Product Suggestions generated yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate AI Suggestions" })).toBeInTheDocument();
  });

  it("Generate calls canonicalProductProposalApi.generate and displays the resulting fresh pending suggestion", async () => {
    const user = userEvent.setup();
    vi.spyOn(canonicalLib.canonicalProductProposalApi, "get").mockRejectedValue(new ApiError("Not found", 404));
    const generateSpy = vi.spyOn(canonicalLib.canonicalProductProposalApi, "generate").mockResolvedValue(baseProposal());
    render(<CanonicalProductAiSuggestionsSection productId="p1" values={values()} productUpdatedAt="2026-01-01T00:00:00.000Z" onApplied={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Generate AI Suggestions" }));
    await waitFor(() => expect(generateSpy).toHaveBeenCalledWith("p1"));
    expect(await screen.findByText("Omega")).toBeInTheDocument();
  });

  it("default-selection: an empty current field is pre-checked, a differing existing human value is NOT pre-checked", async () => {
    vi.spyOn(canonicalLib.canonicalProductProposalApi, "get").mockResolvedValue(baseProposal());
    render(
      <CanonicalProductAiSuggestionsSection
        productId="p1"
        values={values({ brand: "Existing Human Brand", model: "" })}
        productUpdatedAt="2026-01-01T00:00:00.000Z"
        onApplied={vi.fn()}
      />,
    );
    await screen.findByText("Omega");
    const brandCheckbox = screen.getByRole("checkbox", { name: /Brand/ });
    const modelCheckbox = screen.getByRole("checkbox", { name: /Model/ });
    expect(brandCheckbox).not.toBeChecked(); // existing differing human value - never pre-selected
    expect(modelCheckbox).toBeChecked(); // was blank - safe to pre-select
  });

  it("default-selection: an existing value identical to the suggestion is also NOT pre-checked (harmless either way, but never auto-selected)", async () => {
    vi.spyOn(canonicalLib.canonicalProductProposalApi, "get").mockResolvedValue(baseProposal());
    render(
      <CanonicalProductAiSuggestionsSection productId="p1" values={values({ brand: "Omega" })} productUpdatedAt="2026-01-01T00:00:00.000Z" onApplied={vi.fn()} />,
    );
    // "Omega" appears twice here (Current + Suggested, since the values are identical) - wait on
    // the checkbox itself rather than the ambiguous text.
    await screen.findByRole("checkbox", { name: /Brand/ });
    expect(screen.getByRole("checkbox", { name: /Brand/ })).not.toBeChecked();
  });

  it("Accept sends exactly the checked fields and tags, with the proposal's own updatedAt as expectedProposalUpdatedAt, then reports the applied selection via onApplied", async () => {
    const user = userEvent.setup();
    const proposal = baseProposal();
    vi.spyOn(canonicalLib.canonicalProductProposalApi, "get").mockResolvedValue(proposal);
    const returnedProduct = { id: "p1", model: "Speedmaster", updatedAt: "2026-01-02T00:00:00.000Z" };
    const acceptSpy = vi.spyOn(canonicalLib.canonicalProductProposalApi, "accept").mockResolvedValue(returnedProduct as any);
    const onApplied = vi.fn();

    render(
      <CanonicalProductAiSuggestionsSection
        productId="p1"
        values={values({ brand: "Existing", model: "" })}
        productUpdatedAt="2026-01-01T00:00:00.000Z"
        onApplied={onApplied}
      />,
    );
    await screen.findByText("Omega");
    // Model was blank -> pre-selected. Brand was non-empty -> not pre-selected, and we leave it that
    // way. Marketing Tags are additive-only, so "Father's Day" is already pre-selected by default.
    await user.click(screen.getByRole("button", { name: "Accept AI Suggestions" }));

    await waitFor(() =>
      expect(acceptSpy).toHaveBeenCalledWith("p1", {
        expectedProposalUpdatedAt: proposal.updatedAt,
        selectedProductFields: ["model"],
        selectedMarketingTags: ["Father's Day"],
      }),
    );
    expect(onApplied).toHaveBeenCalledWith(["model"], true, returnedProduct);
  });

  it("newer local edit protection: an auto-selected (blank) field is deselected once its live value becomes non-blank", async () => {
    vi.spyOn(canonicalLib.canonicalProductProposalApi, "get").mockResolvedValue(baseProposal());
    const { rerender } = render(
      <CanonicalProductAiSuggestionsSection productId="p1" values={values({ model: "" })} productUpdatedAt="2026-01-01T00:00:00.000Z" onApplied={vi.fn()} />,
    );
    await screen.findByText("Omega");
    expect(screen.getByRole("checkbox", { name: /Model/ })).toBeChecked();

    rerender(
      <CanonicalProductAiSuggestionsSection
        productId="p1"
        values={values({ model: "User Typed This" })}
        productUpdatedAt="2026-01-01T00:00:00.000Z"
        onApplied={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Model/ })).not.toBeChecked());
  });

  it("an explicit user toggle is never auto-revoked by a later live-value change", async () => {
    const user = userEvent.setup();
    vi.spyOn(canonicalLib.canonicalProductProposalApi, "get").mockResolvedValue(baseProposal());
    const { rerender } = render(
      <CanonicalProductAiSuggestionsSection productId="p1" values={values({ model: "" })} productUpdatedAt="2026-01-01T00:00:00.000Z" onApplied={vi.fn()} />,
    );
    await screen.findByText("Omega");
    const modelCheckbox = screen.getByRole("checkbox", { name: /Model/ });
    expect(modelCheckbox).toBeChecked();
    await user.click(modelCheckbox); // explicit deliberate deselect
    expect(modelCheckbox).not.toBeChecked();

    rerender(
      <CanonicalProductAiSuggestionsSection productId="p1" values={values({ model: "" })} productUpdatedAt="2026-01-01T00:00:00.000Z" onApplied={vi.fn()} />,
    );
    expect(screen.getByRole("checkbox", { name: /Model/ })).not.toBeChecked(); // stays exactly as the user left it
  });

  it("PENDING+STALE: disables every checkbox and the Accept button, keeps Regenerate available", async () => {
    vi.spyOn(canonicalLib.canonicalProductProposalApi, "get").mockResolvedValue(baseProposal({ baseProductUpdatedAt: "2025-01-01T00:00:00.000Z" }));
    render(
      <CanonicalProductAiSuggestionsSection productId="p1" values={values()} productUpdatedAt="2026-06-01T00:00:00.000Z" onApplied={vi.fn()} />,
    );
    await screen.findByText("Omega");
    expect(screen.getByRole("checkbox", { name: /Brand/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Accept AI Suggestions" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Regenerate AI Suggestions" })).toBeEnabled();
  });

  it("APPLIED state: no Accept button, only Regenerate", async () => {
    vi.spyOn(canonicalLib.canonicalProductProposalApi, "get").mockResolvedValue(baseProposal({ status: CanonicalProductProposalStatus.Applied }));
    render(<CanonicalProductAiSuggestionsSection productId="p1" values={values()} productUpdatedAt="2026-01-01T00:00:00.000Z" onApplied={vi.fn()} />);
    expect(await screen.findByText("AI Product Suggestions Applied.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept AI Suggestions" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Regenerate AI Suggestions" })).toBeInTheDocument();
  });

  it("Accept is disabled when nothing is selected", async () => {
    vi.spyOn(canonicalLib.canonicalProductProposalApi, "get").mockResolvedValue(baseProposal({ suggestedBrand: "Omega", suggestedModel: undefined, suggestedMarketingTags: undefined }));
    render(
      <CanonicalProductAiSuggestionsSection productId="p1" values={values({ brand: "Already Set" })} productUpdatedAt="2026-01-01T00:00:00.000Z" onApplied={vi.fn()} />,
    );
    await screen.findByText("Omega");
    expect(screen.getByRole("button", { name: "Accept AI Suggestions" })).toBeDisabled();
  });
});
