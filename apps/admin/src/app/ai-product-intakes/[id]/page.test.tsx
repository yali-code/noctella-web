// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AiProductIntakeStatus } from "@noctella/shared";
import { ApiError } from "@/lib/api";
import * as aiProductIntakesLib from "@/lib/aiProductIntakes";
import AiProductIntakeDetailPage from "./page";

vi.mock("./IntakePhotoSection", () => ({
  // Sprint 97 correction: exposes a test-only button that invokes the real onPhotosChanged
  // callback the page passes down, so orchestration behavior (F1) can be exercised without
  // rendering the real IntakePhotoSection.
  IntakePhotoSection: (props: any) => (
    <div data-testid="photo-section">
      <button onClick={() => props.onPhotosChanged()}>trigger-photos-changed</button>
    </div>
  ),
}));
vi.mock("./ProposalReviewSection", () => ({
  // Sprint 97 correction: exposes the received proposal's stale/updatedAt via data attributes so
  // orchestration tests can assert the complete proposal object was replaced, not locally patched.
  ProposalReviewSection: (props: any) => (
    <div data-testid="proposal-section" data-stale={String(props.proposal?.stale)} data-updated-at={props.proposal?.updatedAt ?? ""} />
  ),
}));
vi.mock("./ApplyAndFinalizeSection", () => ({ ApplyAndFinalizeSection: () => <div data-testid="apply-section" /> }));
vi.mock("./IntakeDangerZone", () => ({ IntakeDangerZone: () => <div data-testid="danger-zone" /> }));

afterEach(() => vi.restoreAllMocks());

function intake(overrides: Record<string, unknown> = {}) {
  return {
    id: "intake-1",
    status: AiProductIntakeStatus.Open,
    createdByAdminUserId: "admin-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    id: "proposal-1",
    intakeId: "intake-1",
    title: { suggestion: "Title", decision: "pending", value: null, reviewedByAdminUserId: null, reviewedAt: null },
    description: { suggestion: "Desc", decision: "pending", value: null, reviewedByAdminUserId: null, reviewedAt: null },
    keywords: { suggestion: ["a"], decision: "pending", value: null, reviewedByAdminUserId: null, reviewedAt: null },
    providerName: "mock-intake-v1",
    promptVersion: "v1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    stale: false,
    ...overrides,
  } as any;
}

function mockLoads(intakeOverrides: Record<string, unknown> = {}, proposalRejects = true) {
  vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "get").mockResolvedValue(intake(intakeOverrides));
  vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "listPhotos").mockResolvedValue([]);
  if (proposalRejects) {
    vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "getProposal").mockRejectedValue(new ApiError("not found", 404));
  } else {
    vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "getProposal").mockResolvedValue({} as any);
  }
}

describe("AiProductIntakeDetailPage (Sprint 97)", () => {
  it("loads the intake, photos, and treats a missing proposal (404) as 'not generated yet', not a page failure or a proposal-load-failure state", async () => {
    mockLoads();
    render(<AiProductIntakeDetailPage params={{ id: "intake-1" }} />);
    await screen.findByTestId("proposal-section");
    expect(screen.getByText(AiProductIntakeStatus.Open, { exact: false })).toBeInTheDocument();
    expect(screen.queryByText("Reload proposal")).not.toBeInTheDocument();
  });

  it("shows next-action guidance for an Open intake with no photos", async () => {
    mockLoads();
    render(<AiProductIntakeDetailPage params={{ id: "intake-1" }} />);
    await screen.findByText("Upload staged photos, then generate a proposal.");
  });

  it("shows terminal guidance for a Cancelled intake", async () => {
    mockLoads({ status: AiProductIntakeStatus.Cancelled, cancelledAt: "2026-01-02T00:00:00.000Z" });
    render(<AiProductIntakeDetailPage params={{ id: "intake-1" }} />);
    await screen.findByText(/no further proposal or apply actions/);
  });

  it("shows lifecycle timestamps present on the intake", async () => {
    mockLoads({ status: AiProductIntakeStatus.Cancelled, cancelledAt: "2026-01-02T00:00:00.000Z" });
    render(<AiProductIntakeDetailPage params={{ id: "intake-1" }} />);
    await screen.findByText("Cancelled");
  });

  it("shows the Product link derived from intake.resultProductId, not only from a mutation response", async () => {
    mockLoads({ status: AiProductIntakeStatus.Applied, appliedAt: "t", resultProductId: "product-1" });
    render(<AiProductIntakeDetailPage params={{ id: "intake-1" }} />);
    const link = await screen.findByRole("link", { name: "View Product →" });
    expect(link).toHaveAttribute("href", "/products/product-1");
  });

  it("shows a page-level error when the intake fails to load (404)", async () => {
    vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "get").mockRejectedValue(new ApiError("AI product intake not found", 404));
    vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "listPhotos").mockResolvedValue([]);
    vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "getProposal").mockRejectedValue(new ApiError("not found", 404));
    render(<AiProductIntakeDetailPage params={{ id: "intake-1" }} />);
    await screen.findByText("AI product intake not found");
  });

  it("shows a page-level error for 401", async () => {
    vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "get").mockRejectedValue(new ApiError("Authentication required", 401));
    vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "listPhotos").mockResolvedValue([]);
    vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "getProposal").mockRejectedValue(new ApiError("not found", 404));
    render(<AiProductIntakeDetailPage params={{ id: "intake-1" }} />);
    await screen.findByText("Authentication required");
  });

  it("shows a page-level error for 403", async () => {
    vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "get").mockRejectedValue(new ApiError("Forbidden", 403));
    vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "listPhotos").mockResolvedValue([]);
    vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "getProposal").mockRejectedValue(new ApiError("not found", 404));
    render(<AiProductIntakeDetailPage params={{ id: "intake-1" }} />);
    await screen.findByText("Forbidden");
  });

  it("F1: a successful photo mutation refreshes both the photo list and the proposal, and a newly-stale proposal reaches ProposalReviewSection as a complete replacement", async () => {
    const user = userEvent.setup();
    vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "get").mockResolvedValue(intake());
    const listPhotosSpy = vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "listPhotos").mockResolvedValue([]);
    const getProposalSpy = vi
      .spyOn(aiProductIntakesLib.aiProductIntakesApi, "getProposal")
      .mockResolvedValueOnce(proposal({ stale: false, updatedAt: "t1" }))
      .mockResolvedValueOnce(proposal({ stale: true, updatedAt: "t2" }));

    render(<AiProductIntakeDetailPage params={{ id: "intake-1" }} />);

    const section = await screen.findByTestId("proposal-section");
    expect(section).toHaveAttribute("data-stale", "false");
    expect(listPhotosSpy).toHaveBeenCalledTimes(1);
    expect(getProposalSpy).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "trigger-photos-changed" }));

    await waitFor(() => expect(listPhotosSpy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(getProposalSpy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("proposal-section")).toHaveAttribute("data-stale", "true"));
    expect(screen.getByTestId("proposal-section")).toHaveAttribute("data-updated-at", "t2");
  });

  it("F2: a non-404 proposal load failure renders a proposal-specific failure state (not the absent-proposal UI), blocks proposal controls, performs no mutation, and clears on explicit reload", async () => {
    const user = userEvent.setup();
    vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "get").mockResolvedValue(intake());
    vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "listPhotos").mockResolvedValue([]);
    const generateSpy = vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "generateProposal");
    const getProposalSpy = vi
      .spyOn(aiProductIntakesLib.aiProductIntakesApi, "getProposal")
      .mockRejectedValueOnce(new ApiError("Internal server error", 500))
      .mockResolvedValueOnce(proposal({ stale: false, updatedAt: "t1" }));

    render(<AiProductIntakeDetailPage params={{ id: "intake-1" }} />);

    await screen.findByText("Internal server error");
    expect(screen.queryByTestId("proposal-section")).not.toBeInTheDocument();
    expect(getProposalSpy).toHaveBeenCalledTimes(1);
    expect(generateSpy).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Reload proposal" }));

    await waitFor(() => expect(getProposalSpy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("Internal server error")).not.toBeInTheDocument());
    expect(await screen.findByTestId("proposal-section")).toHaveAttribute("data-updated-at", "t1");
    expect(generateSpy).not.toHaveBeenCalled();
  });
});
