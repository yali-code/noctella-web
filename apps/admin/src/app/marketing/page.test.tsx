// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MarketingPage from "./page";
import { api } from "../../lib/api";

vi.mock("../../lib/api", () => ({ api: { get: vi.fn() } }));

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const plan = (productId: string, hardDailyLimitEur = 5, hardTotalLimitEur = 20) => ({
  productId, generatedAt: "2026-10-10T00:00:00.000Z", scope: "DRAFT_REVIEW_ONLY", inventoryVerification: "VERIFIED", campaignBriefs: [], exclusions: [],
  budget: { productId, currency: "EUR", proposedDailyEur: 2, hardDailyLimitEur, hardTotalLimitEur, decision: "BLOCKED", blockers: ["NO_FINANCIAL_EVIDENCE"], evidence: { landedCostEur: null, historicalProfitEur: null, profitStatus: "UNKNOWN" }, requiresOwnerApproval: true, spendAuthorized: false },
  liveProviderVerified: false, ownerApprovalRecorded: false, spendAuthorized: false,
});
const previewButton = () => screen.getAllByRole("button").find((b) => /Preview campaign draft|Reviewing…/.test(b.textContent ?? ""))!;

/** Audit C2: the original draft-plan preview must never show a plan for other inputs. */
describe("Marketing draft-plan preview: stale responses and budget edits", () => {
  beforeEach(() => vi.mocked(api.get).mockReset());

  it("clears the shown plan when a budget changes and drops the in-flight response for old inputs", async () => {
    const user = userEvent.setup();
    vi.mocked(api.get).mockResolvedValueOnce(plan("NOC-000007"));
    render(<MarketingPage />);
    await user.type(screen.getByLabelText("ERP product ID"), "NOC-000007");
    await user.click(previewButton());
    expect(await screen.findByText(/Review-only plan — NOC-000007/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Total hard cap (EUR)"), "0");
    expect(screen.queryByText(/Review-only plan/)).toBeNull();

    const pending = deferred<unknown>();
    vi.mocked(api.get).mockReturnValueOnce(pending.promise as never);
    await user.click(previewButton());
    await user.clear(screen.getByLabelText("Daily hard cap (EUR)"));
    await user.type(screen.getByLabelText("Daily hard cap (EUR)"), "6");
    expect(previewButton()).toBeEnabled();
    await act(async () => pending.resolve(plan("NOC-000007", 5, 200)));
    expect(screen.queryByText(/Review-only plan/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("drops a late response or error for a previous product", async () => {
    const user = userEvent.setup();
    const first = deferred<unknown>();
    vi.mocked(api.get).mockReturnValueOnce(first.promise as never).mockResolvedValueOnce(plan("NOC-000008"));
    render(<MarketingPage />);
    const input = screen.getByLabelText("ERP product ID");
    await user.type(input, "NOC-000007");
    await user.click(previewButton());
    await user.clear(input);
    await user.type(input, "NOC-000008");
    await user.click(previewButton());
    expect(await screen.findByText(/Review-only plan — NOC-000008/)).toBeInTheDocument();
    await act(async () => first.resolve(plan("NOC-000007")));
    expect(screen.queryByText(/Review-only plan — NOC-000007/)).toBeNull();
    expect(screen.getByText(/Review-only plan — NOC-000008/)).toBeInTheDocument();
  });

  it("refuses a plan built for different caps than requested", async () => {
    const user = userEvent.setup();
    vi.mocked(api.get).mockResolvedValueOnce(plan("NOC-000007", 5, 999));
    render(<MarketingPage />);
    await user.type(screen.getByLabelText("ERP product ID"), "NOC-000007");
    await user.click(previewButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("Unexpected campaign plan safety state");
  });
});
