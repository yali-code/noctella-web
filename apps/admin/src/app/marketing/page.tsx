"use client";

import { useState, type FormEvent } from "react";
import { api } from "../../lib/api";
import { CampaignDraftPreviewReview } from "./CampaignDraftPreviewReview";
import { PaidCampaignPerformanceReview } from "./PaidCampaignPerformanceReview";
import { PaidProviderReadinessReview } from "./PaidProviderReadinessReview";

type CampaignBrief = {
  productId: string;
  destination: "ebay" | "etsy";
  marketplaceUrl: string;
  title: string;
  category: string | null;
  keywordHints: string[];
  objective: "MARKETPLACE_TRAFFIC";
  creativeBrief: { hook: string; proofRequired: string[]; callToAction: string };
  status: "DRAFT";
  humanReviewRequired: true;
};
type DraftPlan = {
  productId: string;
  generatedAt: string;
  scope: "DRAFT_REVIEW_ONLY";
  inventoryVerification: "VERIFIED" | "UNVERIFIED";
  campaignBriefs: CampaignBrief[];
  exclusions: Array<{ productId: string; channel: string; blocker: string }>;
  budget: {
    currency: "EUR";
    proposedDailyEur: number | null;
    hardDailyLimitEur: number;
    hardTotalLimitEur: number;
    decision: "BLOCKED" | "NEEDS_HUMAN_REVIEW";
    blockers: string[];
    evidence: { landedCostEur: number | null; historicalProfitEur: number | null; profitStatus: string };
    requiresOwnerApproval: true;
    spendAuthorized: false;
  };
  liveProviderVerified: false;
  ownerApprovalRecorded: false;
  spendAuthorized: false;
};

const validProductId = /^[A-Za-z0-9_-]{1,100}$/;
function centsAmount(value: string): number | null {
  // Decimal input is intentionally EUR-only, max two decimal places.
  if (!/^(?:0|[1-9][0-9]{0,5})(?:[.][0-9]{1,2})?$/.test(value)) return null;
  const n = Number(value);
  return n > 0 && n <= 1_000_000 ? n : null;
}
function eur(value: number | null): string {
  return value === null ? "Not verified" : `€${value.toFixed(2)}`;
}

export default function MarketingPage() {
  const [productId, setProductId] = useState("");
  const [daily, setDaily] = useState("2");
  const [dailyCap, setDailyCap] = useState("5");
  const [totalCap, setTotalCap] = useState("20");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<DraftPlan | null>(null);

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPlan(null);
    const id = productId.trim();
    const values = [daily, dailyCap, totalCap].map(centsAmount);
    if (!validProductId.test(id) || values.some(n => n === null)) {
      setError("Enter a valid ERP product ID and EUR amounts greater than zero (maximum two decimals).");
      return;
    }
    if (values[0]! > values[1]! || values[1]! > values[2]!) {
      setError("The proposed daily amount must not exceed the daily cap, and the daily cap must not exceed the total cap.");
      return;
    }
    setLoading(true);
    try {
      const query = new URLSearchParams({
        requestedDailyEur: String(values[0]),
        hardDailyLimitEur: String(values[1]),
        hardTotalLimitEur: String(values[2]),
      });
      const result = await api.get<DraftPlan>(`/api/analytics/ads/draft-plan/${encodeURIComponent(id)}?${query.toString()}`);
      if (result.scope !== "DRAFT_REVIEW_ONLY" || result.spendAuthorized !== false
        || result.liveProviderVerified !== false || result.ownerApprovalRecorded !== false) {
        throw new Error("Unexpected campaign plan safety state. No plan was displayed.");
      }
      setPlan(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Campaign preview unavailable.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main>
      <h1>Marketing — Ads Agent</h1>
      <CampaignDraftPreviewReview />
      <p style={{ color: "var(--noctella-aged-bronze)" }}>
        Draft planning only. No ad account is connected here, and this screen cannot publish ads or spend money.
      </p>
      <form onSubmit={generate} style={{ display: "grid", gap: 12, maxWidth: 620, marginTop: 20 }}>
        <label>
          ERP product ID
          <input aria-label="ERP product ID" value={productId} onChange={e => setProductId(e.target.value)}
            required maxLength={100} placeholder="NOC-000007" style={{ width: "100%", padding: 10 }} />
        </label>
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
          {[
            ["Proposed daily (EUR)", daily, setDaily],
            ["Daily hard cap (EUR)", dailyCap, setDailyCap],
            ["Total hard cap (EUR)", totalCap, setTotalCap],
          ].map(([name, value, update]) => (
            <label key={name as string}>
              {name as string}
              <input aria-label={name as string} type="text" inputMode="decimal" value={value as string}
                onChange={e => (update as (v: string) => void)(e.target.value)}
                required style={{ width: "100%", padding: 10 }} />
            </label>
          ))}
        </div>
        <button type="submit" disabled={loading} style={{ padding: 12, width: "fit-content" }}>
          {loading ? "Reviewing…" : "Preview campaign draft"}
        </button>
      </form>

      {error && <p role="alert" style={{ marginTop: 18, color: "crimson" }}>{error}</p>}
      {plan && (
        <section aria-live="polite" style={{ marginTop: 24 }}>
          <h2>Review-only plan — {plan.productId}</h2>
          <p>Inventory verification: <strong>{plan.inventoryVerification}</strong></p>
          <p>Financial assessment: <strong>{plan.budget.decision.replaceAll("_", " ")}</strong></p>
          <p>Proposed daily: {eur(plan.budget.proposedDailyEur)}; hard caps: {eur(plan.budget.hardDailyLimitEur)} per day / {eur(plan.budget.hardTotalLimitEur)} total.</p>
          <p>Cost evidence: {eur(plan.budget.evidence.landedCostEur)}. Previous verified profit: {eur(plan.budget.evidence.historicalProfitEur)}. Financial status: {plan.budget.evidence.profitStatus}.</p>
          {plan.budget.blockers.length > 0 && (
            <div role="status">
              <h3>Budget blockers</h3>
              <ul>{plan.budget.blockers.map((blocker, index) => <li key={index}>{blocker.replaceAll("_", " ")}</li>)}</ul>
            </div>
          )}
          <h3>Campaign drafts ({plan.campaignBriefs.length})</h3>
          {plan.campaignBriefs.length === 0 && <p>No eligible review candidates from currently recorded ERP and marketplace evidence.</p>}
          <ul>
            {plan.campaignBriefs.map((brief, index) => (
              <li key={`${brief.productId}-${brief.destination}-${index}`} style={{ marginBottom: 18 }}>
                <strong>{brief.title}</strong> — {brief.destination.toUpperCase()} — {brief.objective.replaceAll("_", " ")}
                <p>Marketplace listing (historical record): <a href={brief.marketplaceUrl} target="_blank" rel="noopener noreferrer">Open marketplace listing</a></p>
                <p>Keyword hints: {brief.keywordHints.length ? brief.keywordHints.join(", ") : "No validated tags"}</p>
                <p>Creative hook: {brief.creativeBrief.hook}</p>
                <p>Review required: {brief.creativeBrief.proofRequired.join("; ")}</p>
              </li>
            ))}
          </ul>
          {plan.exclusions.length > 0 && (
            <details><summary>Excluded listing records ({plan.exclusions.length})</summary>
              <ul>{plan.exclusions.map((exclusion, index) => <li key={index}>{exclusion.channel || "Unknown channel"}: {exclusion.blocker}</li>)}</ul>
            </details>
          )}
          <p style={{ fontWeight: 700 }}>
            Provider stock not verified live. No approval recorded. Spending disabled.
          </p>
        </section>
      )}
      <PaidProviderReadinessReview />
      <PaidCampaignPerformanceReview />
    </main>
  );
}
