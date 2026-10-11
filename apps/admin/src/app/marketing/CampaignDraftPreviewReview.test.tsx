// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CampaignDraftPreviewReview } from "./CampaignDraftPreviewReview";
import { api } from "../../lib/api";

vi.mock("../../lib/api", () => ({ api: { get: vi.fn() } }));

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const entry = (errors: string[]) => ({
  fingerprint: "a".repeat(64),
  draft: {
    provider: "meta", productId: "NOC-000007", objective: "MARKETPLACE_TRAFFIC", status: "DRAFT",
    destination: { marketplace: "ebay", url: "https://www.ebay.de/itm/1" },
    creative: { format: "CAROUSEL", headline: "Olympus OM-1", primaryText: "As photographed.", callToAction: "View the original listing", mediaPhotoIds: ["ph-1", "ph-2"] },
    targeting: { keywordHints: ["film-camera"], categoryHint: "cat", geography: null, demographics: null, ownerMustConfirm: true },
    budget: { currency: "EUR", proposedDailyEur: null, hardDailyLimitEur: 5, hardTotalLimitEur: 20, guardDecision: "BLOCKED" }, notes: [],
  },
  validation: { valid: errors.length === 0, errors, executionBlockers: ["PROVIDER_EXECUTION_DISABLED"], executionEnabled: false, spendAuthorized: false },
  approval: { status: errors.length ? "DRAFT_INVALID" : "NOT_APPROVED", executionAuthorized: false, spendAuthorized: false },
});
const preview = {
  productId: "NOC-000007", provider: "meta", scope: "DRAFT_PREVIEW_ONLY", capabilityLimitsSource: "PLANNING_DEFAULTS_UNVERIFIED",
  media: { selected: [{ photoId: "ph-1", url: "/x" }, { photoId: "ph-2", url: "/y" }], excluded: [{ photoId: "ph-3", reason: "NOT_READY" }] },
  drafts: [entry(["BUDGET_NOT_PROPOSED", "BUDGET_BLOCKED"])],
  ownerApprovalRecorded: false, executionEnabled: false, spendAuthorized: false,
};
async function submit(productId = "NOC-000007") {
  const user = userEvent.setup();
  render(<CampaignDraftPreviewReview />);
  await user.type(screen.getByLabelText("Draft product ID"), productId);
  await user.click(screen.getByRole("button", { name: "Preview provider campaign draft" }));
}

describe("ADS-008 Admin campaign draft preview", () => {
  beforeEach(() => vi.mocked(api.get).mockReset());

  it("shows media, validation and keeps draft approval separate from execution authorization", async () => {
    vi.mocked(api.get).mockResolvedValue(preview);
    await submit();
    expect(api.get).toHaveBeenCalledWith("/api/analytics/ads/campaign-draft/NOC-000007?provider=meta&requestedDailyEur=2&hardDailyLimitEur=5&hardTotalLimitEur=20");
    expect(await screen.findByText(/Approved ERP media: ph-1, ph-2/)).toHaveTextContent("ph-3 (not ready)");
    expect(screen.getByText(/invalid — budget not proposed, budget blocked/)).toBeInTheDocument();
    expect(screen.getByText("Draft approval").nextSibling).toHaveTextContent("Not recorded — approvals cannot be saved yet (draft invalid)");
    expect(screen.getByText("Execution authorization").nextSibling).toHaveTextContent("Disabled — provider execution disabled");
    expect(screen.getByText(/geography and demographics not set/)).toBeInTheDocument();
    // No approve/launch/budget control: the only button is the preview request.
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Preview provider campaign draft"]);
  });

  it("refuses responses implying a recorded approval, execution or spend authority", async () => {
    for (const tampered of [
      { ...preview, ownerApprovalRecorded: true }, { ...preview, executionEnabled: true }, { ...preview, spendAuthorized: true },
      { ...preview, drafts: [{ ...entry([]), approval: { status: "APPROVED_FOR_EXECUTION_REVIEW", executionAuthorized: true, spendAuthorized: false } }] },
      { ...preview, drafts: [{ ...entry([]), draft: { ...entry([]).draft, status: "ACTIVE" } }] },
    ]) {
      vi.mocked(api.get).mockResolvedValueOnce(tampered);
      const user = userEvent.setup();
      const { unmount } = render(<CampaignDraftPreviewReview />);
      await user.type(screen.getByLabelText("Draft product ID"), "NOC-000007");
      await user.click(screen.getByRole("button", { name: "Preview provider campaign draft" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Unexpected campaign draft response. Nothing displayed.");
      unmount();
    }
  });

  it("validates product id and EUR amounts before calling the API", async () => {
    await submit("bad id!");
    expect(screen.getByRole("alert")).toHaveTextContent("valid ERP product ID");
    expect(api.get).not.toHaveBeenCalled();
  });

  it("editing a budget clears the shown preview and drops the response still in flight", async () => {
    vi.mocked(api.get).mockResolvedValueOnce(preview);
    await submit();
    expect(await screen.findByText(/Approved ERP media/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Draft daily cap EUR"), "0");
    expect(screen.queryByText(/Approved ERP media/)).toBeNull(); // old draft was built for other caps
    const pending = deferred<unknown>();
    vi.mocked(api.get).mockReturnValueOnce(pending.promise as never);
    await user.click(screen.getByRole("button", { name: "Preview provider campaign draft" }));
    await user.clear(screen.getByLabelText("Draft total cap EUR"));
    await user.type(screen.getByLabelText("Draft total cap EUR"), "30");
    expect(screen.getByRole("button", { name: "Preview provider campaign draft" })).toBeEnabled();
    await act(async () => pending.resolve(preview));
    expect(screen.queryByText(/Approved ERP media/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("ignores an in-flight response or error after the provider or product changes", async () => {
    const meta = deferred<unknown>(), product = deferred<unknown>();
    vi.mocked(api.get).mockReturnValueOnce(meta.promise as never).mockReturnValueOnce(product.promise as never);
    await submit();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Draft platform"), "pinterest_ads");
    await act(async () => meta.resolve(preview));
    expect(screen.queryByText(/Approved ERP media/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Preview provider campaign draft" }));
    await user.type(screen.getByLabelText("Draft product ID"), "8");
    await act(async () => product.reject(new Error("late failure")));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows only the latest of overlapping requests regardless of completion order", async () => {
    const older = deferred<unknown>(), newer = deferred<unknown>();
    vi.mocked(api.get).mockReturnValueOnce(older.promise as never).mockReturnValueOnce(newer.promise as never);
    const user = userEvent.setup();
    render(<CampaignDraftPreviewReview />);
    await user.type(screen.getByLabelText("Draft product ID"), "NOC-000007");
    const form = screen.getByLabelText("Draft product ID").closest("form")!;
    await act(async () => { fireEvent.submit(form); fireEvent.submit(form); });
    await act(async () => newer.resolve(preview));
    await act(async () => older.resolve({ ...preview, media: { selected: [{ photoId: "stale-photo", url: "/z" }], excluded: [] } }));
    expect(screen.getByText(/Approved ERP media: ph-1, ph-2/)).toBeInTheDocument();
    expect(screen.queryByText(/stale-photo/)).toBeNull();
    expect(screen.getByRole("button", { name: "Preview provider campaign draft" })).toBeEnabled();
  });

  it("refuses a draft that was not built for the requested caps", async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ ...preview, drafts: [{ ...entry([]), draft: { ...entry([]).draft, budget: { ...entry([]).draft.budget, hardTotalLimitEur: 999 } } }] });
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Unexpected campaign draft response");
  });
});
