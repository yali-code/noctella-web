// @vitest-environment jsdom
// Sprint 145: focused state-machine tests for the inline AI Suggestions panel, isolated from the
// much larger ProductForm suite - covers NONE/PENDING+FRESH/PENDING+STALE/APPLIED, Generate,
// Accept, and error surfacing. Channel-scoped field merge / unsaved-edit preservation / version-
// token advancement are ProductForm-level integration concerns and are covered there instead.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MarketplacePreparationStatus, PublishChannel, type MarketplacePreparation } from "@noctella/shared";
import { ApiError } from "@/lib/api";
import * as publishingLib from "@/lib/publishing";
import { AiChannelSuggestionsSection } from "./AiChannelSuggestionsSection";

afterEach(() => vi.restoreAllMocks());

function basePreparation(overrides: Partial<MarketplacePreparation> = {}): MarketplacePreparation {
  return {
    id: "prep-1",
    productId: "p1",
    channel: PublishChannel.Etsy,
    status: MarketplacePreparationStatus.Pending,
    baseProductUpdatedAt: "2026-01-01T00:00:00.000Z",
    suggestedTitle: "AI Suggested Title",
    suggestedDescription: "AI suggested description.",
    suggestedTags: ["vintage", "handmade"],
    providerName: "mock",
    promptVersion: "v1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("AiChannelSuggestionsSection — Sprint 145", () => {
  it("NONE state: shows a Generate action when no proposal exists (404)", async () => {
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockRejectedValue(new ApiError("Marketplace preparation not found", 404));
    render(
      <AiChannelSuggestionsSection productId="p1" channel={PublishChannel.Etsy} productUpdatedAt="2026-01-01T00:00:00.000Z" onApplied={vi.fn()} />,
    );
    expect(await screen.findByText("No AI suggestions generated yet for this channel.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate AI Suggestions" })).toBeInTheDocument();
  });

  it("Generate: calls marketplacePreparationApi.generate and displays the resulting fresh pending suggestion", async () => {
    const user = userEvent.setup();
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockRejectedValue(new ApiError("Not found", 404));
    const generateSpy = vi.spyOn(publishingLib.marketplacePreparationApi, "generate").mockResolvedValue(basePreparation());
    render(
      <AiChannelSuggestionsSection productId="p1" channel={PublishChannel.Etsy} productUpdatedAt="2026-01-01T00:00:00.000Z" onApplied={vi.fn()} />,
    );
    await user.click(await screen.findByRole("button", { name: "Generate AI Suggestions" }));
    await waitFor(() => expect(generateSpy).toHaveBeenCalledWith("p1", PublishChannel.Etsy));
    expect(await screen.findByText("AI Suggested Title")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept AI Suggestions" })).toBeEnabled();
  });

  it("PENDING+FRESH: displays suggestion values and Accept calls approve with the exact channel fields, then reports the returned Product via onApplied", async () => {
    const user = userEvent.setup();
    const preparation = basePreparation();
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockResolvedValue(preparation);
    const returnedProduct = { id: "p1", etsyTitle: "AI Suggested Title", etsyDescription: "AI suggested description.", etsyTags: ["vintage", "handmade"], updatedAt: "2026-01-02T00:00:00.000Z" };
    const approveSpy = vi.spyOn(publishingLib.marketplacePreparationApi, "approve").mockResolvedValue(returnedProduct as any);
    const onApplied = vi.fn();

    render(
      <AiChannelSuggestionsSection productId="p1" channel={PublishChannel.Etsy} productUpdatedAt="2026-01-01T00:00:00.000Z" onApplied={onApplied} />,
    );
    expect(await screen.findByText("AI Suggested Title")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Accept AI Suggestions" }));

    await waitFor(() =>
      expect(approveSpy).toHaveBeenCalledWith("p1", {
        channel: PublishChannel.Etsy,
        expectedProposalUpdatedAt: preparation.updatedAt,
        title: "AI Suggested Title",
        description: "AI suggested description.",
        tags: ["vintage", "handmade"],
      }),
    );
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith(PublishChannel.Etsy, returnedProduct));
  });

  it("PENDING+STALE: Accept is disabled and a stale message is shown when baseProductUpdatedAt no longer matches the current Product version; Regenerate remains available", async () => {
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockResolvedValue(
      basePreparation({ baseProductUpdatedAt: "2026-01-01T00:00:00.000Z" }),
    );
    render(
      <AiChannelSuggestionsSection productId="p1" channel={PublishChannel.Etsy} productUpdatedAt="2026-01-05T00:00:00.000Z" onApplied={vi.fn()} />,
    );
    expect(await screen.findByText(/earlier version of this Product/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept AI Suggestions" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Regenerate AI Suggestions" })).toBeEnabled();
  });

  it("PENDING+STALE: clicking Accept while disabled never calls the approve endpoint (defensive guard, not just UI disablement)", async () => {
    const user = userEvent.setup();
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockResolvedValue(
      basePreparation({ baseProductUpdatedAt: "2026-01-01T00:00:00.000Z" }),
    );
    const approveSpy = vi.spyOn(publishingLib.marketplacePreparationApi, "approve");
    render(
      <AiChannelSuggestionsSection productId="p1" channel={PublishChannel.Etsy} productUpdatedAt="2026-01-05T00:00:00.000Z" onApplied={vi.fn()} />,
    );
    const acceptButton = await screen.findByRole("button", { name: "Accept AI Suggestions" });
    await user.click(acceptButton);
    expect(approveSpy).not.toHaveBeenCalled();
  });

  it("APPLIED: shows an applied state, offers Regenerate (mirrors existing Publishing-page behavior), and never shows Accept", async () => {
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockResolvedValue(
      basePreparation({ status: MarketplacePreparationStatus.Applied, appliedAt: "2026-01-02T00:00:00.000Z" }),
    );
    render(
      <AiChannelSuggestionsSection productId="p1" channel={PublishChannel.Etsy} productUpdatedAt="2026-01-01T00:00:00.000Z" onApplied={vi.fn()} />,
    );
    expect(await screen.findByText("AI Suggestions Applied.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept AI Suggestions" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Regenerate AI Suggestions" })).toBeInTheDocument();
  });

  it("Generate error (e.g. generation already in progress) is surfaced locally and never throws/crashes", async () => {
    const user = userEvent.setup();
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockRejectedValue(new ApiError("Not found", 404));
    vi.spyOn(publishingLib.marketplacePreparationApi, "generate").mockRejectedValue(
      new ApiError("A marketplace preparation is already in progress for this product and channel. Wait for it to complete, then try again.", 409),
    );
    render(
      <AiChannelSuggestionsSection productId="p1" channel={PublishChannel.Etsy} productUpdatedAt="2026-01-01T00:00:00.000Z" onApplied={vi.fn()} />,
    );
    await user.click(await screen.findByRole("button", { name: "Generate AI Suggestions" }));
    expect(await screen.findByText(/already in progress/)).toBeInTheDocument();
  });

  it("Approve version-conflict error (MARKETPLACE_PREPARATION_VERSION_CONFLICT) is surfaced locally and onApplied is never called", async () => {
    const user = userEvent.setup();
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockResolvedValue(basePreparation());
    vi.spyOn(publishingLib.marketplacePreparationApi, "approve").mockRejectedValue(
      new ApiError("This marketplace preparation changed since you loaded it. Reload it and try again.", 409, undefined, "MARKETPLACE_PREPARATION_VERSION_CONFLICT"),
    );
    const onApplied = vi.fn();
    render(
      <AiChannelSuggestionsSection productId="p1" channel={PublishChannel.Etsy} productUpdatedAt="2026-01-01T00:00:00.000Z" onApplied={onApplied} />,
    );
    await user.click(await screen.findByRole("button", { name: "Accept AI Suggestions" }));
    expect(await screen.findByText(/changed since you loaded it/)).toBeInTheDocument();
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("Approve Product-version-conflict error (PRODUCT_VERSION_CONFLICT) is surfaced locally and onApplied is never called", async () => {
    const user = userEvent.setup();
    vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockResolvedValue(basePreparation());
    vi.spyOn(publishingLib.marketplacePreparationApi, "approve").mockRejectedValue(
      new ApiError("This product changed after you opened it. Reload the latest version before saving again.", 409, undefined, "PRODUCT_VERSION_CONFLICT"),
    );
    const onApplied = vi.fn();
    render(
      <AiChannelSuggestionsSection productId="p1" channel={PublishChannel.Etsy} productUpdatedAt="2026-01-01T00:00:00.000Z" onApplied={onApplied} />,
    );
    await user.click(await screen.findByRole("button", { name: "Accept AI Suggestions" }));
    expect(await screen.findByText(/This product changed after you opened it/)).toBeInTheDocument();
    expect(onApplied).not.toHaveBeenCalled();
  });
});
