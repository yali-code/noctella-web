"use client";

import { useState, type FormEvent } from "react";
import { api } from "../../../lib/api";

type Provider = "meta" | "google_ads" | "pinterest_ads";
type PerformanceEvidence = {
  evidenceLevel: "INCOMPLETE" | "SPEND_AND_TRAFFIC_ONLY" | "PROVIDER_REPORTED_CONVERSIONS";
  spendEur: number | null;
  impressions: number | null;
  clicks: number | null;
  providerReportedConversions: number | null;
  providerReportedConversionValueEur: number | null;
  marketplaceConfirmedOrders: number | null;
  reportedRoas: number | null;
  attributedMarketplaceRevenueEur: null;
  cannotInferMarketplacePurchasesFromClicks: true;
  warnings: string[];
};
type OptimizationAdvice = {
  recommendation: string;
  reasons: string[];
  eligibleForAutomaticAction: false;
  budgetChangeEur: null;
  campaignPauseExecuted: false;
  spendAuthorized: false;
};
type PaidCampaignReadout = {
  provider: Provider;
  campaignId: string;
  status: "NOT_COLLECTED" | "UNTRUSTED_EVIDENCE" | "REPORT_AVAILABLE";
  source: "EXISTING_ANALYTICS_SNAPSHOTS";
  marketplaceAttributionVerified: false;
  spendAuthorized: false;
  evidence: PerformanceEvidence | null;
  advice: OptimizationAdvice | null;
  period?: { start: string; end: string };
  collectedAt?: string;
};
const validCampaignId = /^[0-9]{5,25}$/;
const display = (value: number | null, unit: "eur" | "count" | "ratio") => {
  if (value === null || !Number.isFinite(value)) return "Unknown";
  if (unit === "eur") return `€${value.toFixed(2)}`;
  if (unit === "ratio") return `${value.toFixed(2)}x (provider-reported)`;
  return value.toLocaleString("en-GB");
};

/** Paid providers only; never re-label organic reach as ad impressions. */
export function PaidCampaignPerformanceReview() {
  const [provider, setProvider] = useState<Provider>("meta");
  const [campaignId, setCampaignId] = useState("");
  const [report, setReport] = useState<PaidCampaignReadout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setReport(null);
    setError(null);
    const id = campaignId.trim();
    if (!validCampaignId.test(id)) {
      setError("Enter the exact numeric advertising campaign ID (5–25 digits).");
      return;
    }
    setLoading(true);
    try {
      const result = await api.get<PaidCampaignReadout>(
        `/api/analytics/ads/performance/${provider}/${encodeURIComponent(id)}`,
      );
      // Refuse any newly altered response that tries to convey spend authority.
      if (result.provider !== provider || result.campaignId !== id
        || result.spendAuthorized !== false || result.marketplaceAttributionVerified !== false
        || result.source !== "EXISTING_ANALYTICS_SNAPSHOTS"
        || !["NOT_COLLECTED", "UNTRUSTED_EVIDENCE", "REPORT_AVAILABLE"].includes(result.status)
        || (result.status === "REPORT_AVAILABLE" && (!result.evidence || !result.advice))
        || (result.advice && (result.advice.spendAuthorized !== false
          || result.advice.eligibleForAutomaticAction !== false
          || result.advice.budgetChangeEur !== null
          || result.advice.campaignPauseExecuted !== false))
      ) {
        throw new Error("Unexpected paid reporting state. No report displayed.");
      }
      setReport(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Paid campaign report unavailable.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section aria-label="Paid Ads performance" style={{ marginTop: 36, borderTop: "1px solid #8b6b2e", paddingTop: 22 }}>
      <h2>Paid campaign performance — evidence only</h2>
      <p>Reads existing Analytics Agent observations. No paid provider is connected by this screen. Missing data is not zero spend or zero sales.</p>
      <form onSubmit={load} style={{ display: "flex", flexWrap: "wrap", alignItems: "end", gap: 12 }}>
        <label>
          Advertising platform
          <select aria-label="Advertising platform" value={provider} onChange={event => {
            setProvider(event.target.value as Provider);
            setReport(null);
          }} style={{ display: "block", padding: 10 }}>
            <option value="meta">Meta Ads</option>
            <option value="google_ads">Google Ads</option>
            <option value="pinterest_ads">Pinterest Ads</option>
          </select>
        </label>
        <label>
          Provider campaign ID
          <input aria-label="Provider campaign ID" value={campaignId} onChange={event => {
            setCampaignId(event.target.value);
            setReport(null);
          }} maxLength={25} inputMode="numeric" placeholder="1234567890"
            style={{ display: "block", padding: 10 }} />
        </label>
        <button type="submit" disabled={loading} style={{ padding: 12 }}>
          {loading ? "Checking…" : "Review paid performance"}
        </button>
      </form>
      {error && <p role="alert" style={{ color: "crimson" }}>{error}</p>}
      {report && (
        <div aria-live="polite" style={{ marginTop: 16 }}>
          <h3>Evidence status: {report.status.replaceAll("_", " ")}</h3>
          {report.status === "NOT_COLLECTED" && (
            <p>There are no verified paid-campaign snapshots for this campaign. Connect and authorize a paid Ads collector before expecting results.</p>
          )}
          {report.status === "UNTRUSTED_EVIDENCE" && (
            <p>Analytics observations did not pass source, currency, run, or period checks. No metric or ROAS has been accepted.</p>
          )}
          {report.status === "REPORT_AVAILABLE" && report.evidence && (
            <>
              <p>Reporting window: {report.period?.start ?? "Unknown"} — {report.period?.end ?? "Unknown"}</p>
              <dl style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))" }}>
                {([
                  ["Ad spend", display(report.evidence.spendEur, "eur")],
                  ["Impressions", display(report.evidence.impressions, "count")],
                  ["Clicks", display(report.evidence.clicks, "count")],
                  ["Provider conversions", display(report.evidence.providerReportedConversions, "count")],
                  ["Provider reported ROAS", display(report.evidence.reportedRoas, "ratio")],
                ] as const).map(([label, value]) => (
                  <div key={label}><dt>{label}</dt><dd style={{ margin: 0, fontWeight: 600 }}>{value}</dd></div>
                ))}
              </dl>
              <p>Marketplace-attributed revenue: <strong>Not verified</strong>. Provider conversions do not prove an eBay/Etsy sale.</p>
              {report.evidence.warnings.length > 0 && (
                <p role="status">Evidence warnings: {report.evidence.warnings.join("; ")}</p>
              )}
              {report.advice && (
                <div>
                  <h4>Advisory recommendation: {report.advice.recommendation.replaceAll("_", " ")}</h4>
                  <ul>{report.advice.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul>
                </div>
              )}
            </>
          )}
          <p style={{ fontWeight: 600 }}>No budget change, campaign launch, or automatic pause is authorized by this report.</p>
        </div>
      )}
    </section>
  );
}
