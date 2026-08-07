// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AiIntakeFieldDecision, AiProductIntakeStatus } from "@noctella/shared";
import { ApiError } from "@/lib/api";
import * as aiProductIntakesLib from "@/lib/aiProductIntakes";
import { ProposalReviewSection } from "./ProposalReviewSection";

afterEach(() => vi.restoreAllMocks());

function reviewedField(overrides: Record<string, unknown> = {}) {
  return { suggestion: "Suggested value", decision: AiIntakeFieldDecision.Pending, value: null, reviewedByAdminUserId: null, reviewedAt: null, ...overrides };
}

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    id: "proposal-1",
    intakeId: "intake-1",
    title: reviewedField(),
    description: reviewedField(),
    keywords: reviewedField({ suggestion: ["a", "b"] }),
    providerName: "mock-intake-v1",
    promptVersion: "v1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    stale: false,
    ...overrides,
  } as any;
}

describe("ProposalReviewSection (Sprint 97)", () => {
  it("shows a zero-photo warning without disabling Generate", () => {
    render(
      <ProposalReviewSection
        intakeId="intake-1"
        intakeStatus={AiProductIntakeStatus.Open}
        photos={[]}
        proposal={null}
        onProposalChanged={vi.fn()}
        onProposalReload={vi.fn()}
      />,
    );
    expect(screen.getByText(/less useful without them/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled();
  });

  it("Generate calls generateProposal and replaces state with the full response", async () => {
    const user = userEvent.setup();
    const onProposalChanged = vi.fn();
    const generated = proposal();
    vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "generateProposal").mockResolvedValue(generated);
    render(
      <ProposalReviewSection
        intakeId="intake-1"
        intakeStatus={AiProductIntakeStatus.Open}
        photos={[]}
        proposal={null}
        onProposalChanged={onProposalChanged}
        onProposalReload={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(onProposalChanged).toHaveBeenCalledWith(generated));
  });

  it("Accept sends the current proposal's updatedAt as expectedUpdatedAt", async () => {
    const user = userEvent.setup();
    const current = proposal();
    const spy = vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "updateFieldReview").mockResolvedValue(proposal());
    render(
      <ProposalReviewSection
        intakeId="intake-1"
        intakeStatus={AiProductIntakeStatus.Open}
        photos={[]}
        proposal={current}
        onProposalChanged={vi.fn()}
        onProposalReload={vi.fn()}
      />,
    );
    const acceptButtons = screen.getAllByRole("button", { name: "Accept" });
    await user.click(acceptButtons[0]);
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith("intake-1", "title", AiIntakeFieldDecision.Accepted, "2026-01-01T00:00:00.000Z", undefined),
    );
  });

  it("Edit opens an input, and submitting calls updateFieldReview with Edited and the typed value", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "updateFieldReview").mockResolvedValue(proposal());
    render(
      <ProposalReviewSection
        intakeId="intake-1"
        intakeStatus={AiProductIntakeStatus.Open}
        photos={[]}
        proposal={proposal()}
        onProposalChanged={vi.fn()}
        onProposalReload={vi.fn()}
      />,
    );
    const editButtons = screen.getAllByRole("button", { name: "Edit" });
    await user.click(editButtons[0]);
    const input = screen.getByDisplayValue("Suggested value");
    await user.clear(input);
    await user.type(input, "My Edited Title");
    await user.click(screen.getByRole("button", { name: "Save Edit" }));
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith("intake-1", "title", AiIntakeFieldDecision.Edited, "2026-01-01T00:00:00.000Z", "My Edited Title"),
    );
  });

  it("Reject sends the Rejected decision", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "updateFieldReview").mockResolvedValue(proposal());
    render(
      <ProposalReviewSection
        intakeId="intake-1"
        intakeStatus={AiProductIntakeStatus.Open}
        photos={[]}
        proposal={proposal()}
        onProposalChanged={vi.fn()}
        onProposalReload={vi.fn()}
      />,
    );
    const rejectButtons = screen.getAllByRole("button", { name: "Reject" });
    await user.click(rejectButtons[0]);
    await waitFor(() => expect(spy).toHaveBeenCalledWith("intake-1", "title", AiIntakeFieldDecision.Rejected, "2026-01-01T00:00:00.000Z", undefined));
  });

  it("Reset to Pending is disabled once a field is already Pending, and enabled once a field is Accepted", async () => {
    const acceptedProposal = proposal({ title: reviewedField({ decision: AiIntakeFieldDecision.Accepted, value: "x", reviewedByAdminUserId: "a", reviewedAt: "t" }) });
    render(
      <ProposalReviewSection
        intakeId="intake-1"
        intakeStatus={AiProductIntakeStatus.Open}
        photos={[]}
        proposal={acceptedProposal}
        onProposalChanged={vi.fn()}
        onProposalReload={vi.fn()}
      />,
    );
    const resetButtons = screen.getAllByRole("button", { name: "Reset to Pending" });
    expect(resetButtons[0]).toBeEnabled(); // title: Accepted
    expect(resetButtons[1]).toBeDisabled(); // description: Pending
  });

  it("stale: Accept/Edit/Reject are disabled and recovery guidance is shown; Reset remains available", () => {
    const staleProposal = proposal({ stale: true, title: reviewedField({ decision: AiIntakeFieldDecision.Accepted, value: "x", reviewedByAdminUserId: "a", reviewedAt: "t" }) });
    render(
      <ProposalReviewSection
        intakeId="intake-1"
        intakeStatus={AiProductIntakeStatus.Open}
        photos={[]}
        proposal={staleProposal}
        onProposalChanged={vi.fn()}
        onProposalReload={vi.fn()}
      />,
    );
    expect(screen.getByText(/staged photos changed after this proposal was generated/)).toBeInTheDocument();
    const acceptButtons = screen.getAllByRole("button", { name: "Accept" });
    const editButtons = screen.getAllByRole("button", { name: "Edit" });
    const rejectButtons = screen.getAllByRole("button", { name: "Reject" });
    const resetButtons = screen.getAllByRole("button", { name: "Reset to Pending" });
    acceptButtons.forEach((b) => expect(b).toBeDisabled());
    editButtons.forEach((b) => expect(b).toBeDisabled());
    rejectButtons.forEach((b) => expect(b).toBeDisabled());
    expect(resetButtons[0]).toBeEnabled(); // title is Accepted -> reset available even while stale
  });

  it("an optimistic-concurrency conflict shows a reload prompt and never automatically resubmits", async () => {
    const user = userEvent.setup();
    const updateSpy = vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "updateFieldReview").mockRejectedValue(
      new ApiError("This proposal changed before the operation completed.", 409, undefined, "AI_INTAKE_PROPOSAL_VERSION_CONFLICT"),
    );
    const onProposalReload = vi.fn().mockResolvedValue(proposal());
    render(
      <ProposalReviewSection
        intakeId="intake-1"
        intakeStatus={AiProductIntakeStatus.Open}
        photos={[]}
        proposal={proposal()}
        onProposalChanged={vi.fn()}
        onProposalReload={onProposalReload}
      />,
    );
    await user.click(screen.getAllByRole("button", { name: "Accept" })[0]);
    await screen.findByText("This proposal changed before the operation completed.");
    expect(updateSpy).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(onProposalReload).toHaveBeenCalledTimes(1));
    expect(updateSpy).toHaveBeenCalledTimes(1); // still only the original attempt - no auto-resubmit
  });

  it("Regenerate is blocked while any field is non-Pending, and enabled once all three are Pending", async () => {
    const user = userEvent.setup();
    const mixedProposal = proposal({ title: reviewedField({ decision: AiIntakeFieldDecision.Accepted, value: "x", reviewedByAdminUserId: "a", reviewedAt: "t" }) });
    const { rerender } = render(
      <ProposalReviewSection
        intakeId="intake-1"
        intakeStatus={AiProductIntakeStatus.Open}
        photos={[]}
        proposal={mixedProposal}
        onProposalChanged={vi.fn()}
        onProposalReload={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Regenerate" })).toBeDisabled();

    const allPendingProposal = proposal();
    rerender(
      <ProposalReviewSection
        intakeId="intake-1"
        intakeStatus={AiProductIntakeStatus.Open}
        photos={[]}
        proposal={allPendingProposal}
        onProposalChanged={vi.fn()}
        onProposalReload={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Regenerate" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(screen.getByRole("button", { name: "Confirm Regenerate" })).toBeInTheDocument();
  });

  it("Open intake: Accept/Edit/Reject/Reset controls remain enabled (unaffected by the M1 correction)", () => {
    const mixedProposal = proposal({ title: reviewedField({ decision: AiIntakeFieldDecision.Accepted, value: "x", reviewedByAdminUserId: "a", reviewedAt: "t" }) });
    render(
      <ProposalReviewSection
        intakeId="intake-1"
        intakeStatus={AiProductIntakeStatus.Open}
        photos={[]}
        proposal={mixedProposal}
        onProposalChanged={vi.fn()}
        onProposalReload={vi.fn()}
      />,
    );
    screen.getAllByRole("button", { name: "Accept" }).forEach((b) => expect(b).toBeEnabled());
    screen.getAllByRole("button", { name: "Edit" }).forEach((b) => expect(b).toBeEnabled());
    screen.getAllByRole("button", { name: "Reject" }).forEach((b) => expect(b).toBeEnabled());
    expect(screen.getAllByRole("button", { name: "Reset to Pending" })[0]).toBeEnabled(); // title: Accepted
  });

  describe("M1 correction: proposal review is available only while the intake is Open", () => {
    it.each([
      ["Applied", AiProductIntakeStatus.Applied],
      ["Finalized", AiProductIntakeStatus.Finalized],
      ["Cancelled", AiProductIntakeStatus.Cancelled],
    ])(
      "%s intake with a non-null proposal: content remains visible, all mutation controls are unavailable, and no mutation request is issued",
      async (_label, status) => {
        const user = userEvent.setup();
        const generateSpy = vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "generateProposal");
        const updateSpy = vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "updateFieldReview");
        // title is Accepted (non-Pending) so Reset's disablement here is provably caused by the
        // status gate, not by the pre-existing isPending condition it would otherwise satisfy.
        const mixedProposal = proposal({
          title: reviewedField({ decision: AiIntakeFieldDecision.Accepted, value: "Accepted Title", reviewedByAdminUserId: "a", reviewedAt: "t" }),
        });

        render(
          <ProposalReviewSection
            intakeId="intake-1"
            intakeStatus={status}
            photos={[]}
            proposal={mixedProposal}
            onProposalChanged={vi.fn()}
            onProposalReload={vi.fn()}
          />,
        );

        // Proposal content (suggestion + stored decision/value) remains visible.
        expect(screen.getByText(/Accepted Title/)).toBeInTheDocument();
        expect(screen.getAllByText(/Suggestion:/).length).toBeGreaterThan(0);

        // All mutation controls are unavailable.
        const acceptButtons = screen.getAllByRole("button", { name: "Accept" });
        const editButtons = screen.getAllByRole("button", { name: "Edit" });
        const rejectButtons = screen.getAllByRole("button", { name: "Reject" });
        const resetButtons = screen.getAllByRole("button", { name: "Reset to Pending" });
        expect(acceptButtons).toHaveLength(3);
        acceptButtons.forEach((b) => expect(b).toBeDisabled());
        editButtons.forEach((b) => expect(b).toBeDisabled());
        rejectButtons.forEach((b) => expect(b).toBeDisabled());
        resetButtons.forEach((b) => expect(b).toBeDisabled());
        expect(screen.queryByRole("button", { name: "Regenerate" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Generate" })).not.toBeInTheDocument();

        // Clicking a disabled control fires no handler and issues no request.
        await user.click(acceptButtons[0]);
        await user.click(editButtons[0]);
        await user.click(rejectButtons[0]);
        await user.click(resetButtons[0]);
        expect(updateSpy).not.toHaveBeenCalled();
        expect(generateSpy).not.toHaveBeenCalled();
        expect(screen.queryByRole("button", { name: "Save Edit" })).not.toBeInTheDocument(); // Edit never opened
      },
    );
  });

  describe("Sprint 99: local edit-state reset on proposal version change", () => {
    async function startEditingTitle(user: ReturnType<typeof userEvent.setup>, initialProposal: any) {
      const { rerender } = render(
        <ProposalReviewSection
          intakeId="intake-1"
          intakeStatus={AiProductIntakeStatus.Open}
          photos={[]}
          proposal={initialProposal}
          onProposalChanged={vi.fn()}
          onProposalReload={vi.fn()}
        />,
      );
      const editButtons = screen.getAllByRole("button", { name: "Edit" });
      await user.click(editButtons[0]);
      const input = screen.getByDisplayValue("Suggested value");
      await user.clear(input);
      await user.type(input, "My In-Progress Edit");
      return rerender;
    }

    it("editing state remains when the same proposal version is re-rendered", async () => {
      const user = userEvent.setup();
      const rerender = await startEditingTitle(user, proposal());
      rerender(
        <ProposalReviewSection
          intakeId="intake-1"
          intakeStatus={AiProductIntakeStatus.Open}
          photos={[]}
          proposal={proposal()} // same id+updatedAt, deliberately a new object reference
          onProposalChanged={vi.fn()}
          onProposalReload={vi.fn()}
        />,
      );
      expect(screen.getByDisplayValue("My In-Progress Edit")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save Edit" })).toBeInTheDocument();
    });

    it("editing state resets when proposal.updatedAt changes", async () => {
      const user = userEvent.setup();
      const rerender = await startEditingTitle(user, proposal());
      rerender(
        <ProposalReviewSection
          intakeId="intake-1"
          intakeStatus={AiProductIntakeStatus.Open}
          photos={[]}
          proposal={proposal({ updatedAt: "2026-01-02T00:00:00.000Z" })}
          onProposalChanged={vi.fn()}
          onProposalReload={vi.fn()}
        />,
      );
      expect(screen.queryByDisplayValue("My In-Progress Edit")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Save Edit" })).not.toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: "Edit" })[0]).toBeInTheDocument();
    });

    it("editing state resets when proposal identity changes", async () => {
      const user = userEvent.setup();
      const rerender = await startEditingTitle(user, proposal());
      rerender(
        <ProposalReviewSection
          intakeId="intake-1"
          intakeStatus={AiProductIntakeStatus.Open}
          photos={[]}
          proposal={proposal({ id: "proposal-2" })}
          onProposalChanged={vi.fn()}
          onProposalReload={vi.fn()}
        />,
      );
      expect(screen.queryByDisplayValue("My In-Progress Edit")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Save Edit" })).not.toBeInTheDocument();
    });

    it("no API mutation is triggered by the reset", async () => {
      const user = userEvent.setup();
      const updateSpy = vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "updateFieldReview");
      const generateSpy = vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "generateProposal");
      const rerender = await startEditingTitle(user, proposal());
      rerender(
        <ProposalReviewSection
          intakeId="intake-1"
          intakeStatus={AiProductIntakeStatus.Open}
          photos={[]}
          proposal={proposal({ updatedAt: "2026-01-02T00:00:00.000Z" })}
          onProposalChanged={vi.fn()}
          onProposalReload={vi.fn()}
        />,
      );
      expect(updateSpy).not.toHaveBeenCalled();
      expect(generateSpy).not.toHaveBeenCalled();
    });
  });

  it("successful regeneration (after confirmation) replaces the complete proposal state", async () => {
    const user = userEvent.setup();
    const onProposalChanged = vi.fn();
    const regenerated = proposal({ generatedAt: "2026-02-01T00:00:00.000Z" });
    vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "generateProposal").mockResolvedValue(regenerated);
    render(
      <ProposalReviewSection
        intakeId="intake-1"
        intakeStatus={AiProductIntakeStatus.Open}
        photos={[]}
        proposal={proposal()}
        onProposalChanged={onProposalChanged}
        onProposalReload={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Regenerate" }));
    await user.click(screen.getByRole("button", { name: "Confirm Regenerate" }));
    await waitFor(() => expect(onProposalChanged).toHaveBeenCalledWith(regenerated));
  });
});
