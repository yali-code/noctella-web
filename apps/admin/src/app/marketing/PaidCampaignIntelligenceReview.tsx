"use client";

import { useRef, useState, type FormEvent } from "react";
import { api } from "../../lib/api";

type Provider = "meta" | "google_ads" | "pinterest_ads";
type Window = {
  period: { start: string; end: string };
  spendEur: number | null; impressions: number | null; clicks: number | null;
  rates: { days: number; spendEurPerDay: number | null; cpcEur: number | null; cpmEur: number | null; ctr: number | null; gaps: string[] };
};
type Intelligence = {
  provider: Provider; campaignId: string; currency: "EUR"; source: "EXISTING_ANALYTICS_SNAPSHOTS";
  status: "NOT_COLLECTED" | "ANALYSED" | "ACCOUNT_CONFLICT";
  accountId: string | null;
  accountConflict: { accountId: string; windows: number }[];
  windows: Window[];
  trend: { spendPerDayChange: number | null; ctrChange: number | null; cpcChange: number | null; cpmChange: number | null } | null;
  anomalies: { code: string; detail: string }[];
  recommendations: { code: string; reason: string }[];
  dataQuality: { untrustedWindows: number; overlappingWindowsExcluded: number };
  marketplaceAttributionVerified: false; marketplaceRoas: null; organicMetricsIncluded: false;
  eligibleForAutomaticAction: false; budgetChangeEur: null; spendAuthorized: false;
};
const DATA_QUALITY = new Set(["SPEND_WITHOUT_DELIVERY", "DELIVERY_WITHOUT_SPEND", "CLICKS_EXCEED_IMPRESSIONS"]);
const eur = (v: number | null, digits = 2) => (v === null || !Number.isFinite(v) ? "Unknown" : `€${v.toFixed(digits)}`);
const num = (v: number | null) => (v === null || !Number.isFinite(v) ? "Unknown" : v.toLocaleString("en-GB"));
const pct = (v: number | null) => (v === null || !Number.isFinite(v) ? "Unknown" : `${(v * 100).toFixed(2)}%`);
const change = (v: number | null) => (v === null || !Number.isFinite(v) ? "n/a" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(1)}%`);
const label = (code: string) => code.replaceAll("_", " ").toLowerCase();

/** ADS-007: advisory paid-ads intelligence. Displays analysis only; offers no campaign or budget control. */
export function PaidCampaignIntelligenceReview() {
  const [provider, setProvider] = useState<Provider>("meta");
  const [campaignId, setCampaignId] = useState("");
  const [result, setResult] = useState<Intelligence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Only the latest request may update the screen: older responses are dropped, never shown.
  const requestSeq = useRef(0);
  const invalidate = () => { requestSeq.current += 1; setResult(null); setError(null); setLoading(false); };

  async function load(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    invalidate();
    const id = campaignId.trim();
    if (!/^[0-9]{5,25}$/.test(id)) { setError("Enter the exact numeric advertising campaign ID (5–25 digits)."); return; }
    const seq = requestSeq.current;
    const requested = provider;
    setLoading(true);
    try {
      const r = await api.get<Intelligence>(`/api/analytics/ads/intelligence/${requested}/${encodeURIComponent(id)}`);
      if (seq !== requestSeq.current) return;
      // Refuse any response that claims authority, attribution or organic data.
      if (r.provider !== requested || r.campaignId !== id || r.currency !== "EUR" || r.source !== "EXISTING_ANALYTICS_SNAPSHOTS"
        || !["NOT_COLLECTED", "ANALYSED", "ACCOUNT_CONFLICT"].includes(r.status) || !Array.isArray(r.windows) || !Array.isArray(r.anomalies) || !Array.isArray(r.recommendations)
        || (r.status === "ACCOUNT_CONFLICT" && (r.windows.length > 0 || r.trend !== null || r.anomalies.length > 0))
        || r.spendAuthorized !== false || r.eligibleForAutomaticAction !== false || r.budgetChangeEur !== null
        || r.marketplaceRoas !== null || r.marketplaceAttributionVerified !== false || r.organicMetricsIncluded !== false) {
        throw new Error("Unexpected intelligence response. Nothing displayed.");
      }
      setResult(r);
    } catch (cause) {
      if (seq !== requestSeq.current) return;
      setError(cause instanceof Error ? cause.message : "Paid intelligence unavailable.");
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }

  const quality = result ? result.anomalies.filter((a) => DATA_QUALITY.has(a.code)) : [];
  const performance = result ? result.anomalies.filter((a) => !DATA_QUALITY.has(a.code)) : [];
  return (
    <section aria-label="Paid Ads intelligence" style={{ marginTop: 36, borderTop: "1px solid #8b6b2e", paddingTop: 22 }}>
      <h2>Paid campaign intelligence — advisory only</h2>
      <p>Compares stored, verified paid-provider windows for one campaign. Organic social metrics are never included; missing values are shown as unknown, never zero.</p>
      <form onSubmit={load} style={{ display: "flex", flexWrap: "wrap", alignItems: "end", gap: 12 }}>
        <label>
          Intelligence platform
          <select aria-label="Intelligence platform" value={provider} onChange={(e) => { setProvider(e.target.value as Provider); invalidate(); }} style={{ display: "block", padding: 10 }}>
            <option value="meta">Meta Ads</option>
            <option value="google_ads">Google Ads</option>
            <option value="pinterest_ads">Pinterest Ads</option>
          </select>
        </label>
        <label>
          Intelligence campaign ID
          <input aria-label="Intelligence campaign ID" value={campaignId} onChange={(e) => { setCampaignId(e.target.value); invalidate(); }} maxLength={25} inputMode="numeric" style={{ display: "block", padding: 10 }} />
        </label>
        <button type="submit" disabled={loading} style={{ padding: 12 }}>{loading ? "Analysing…" : "Analyse paid campaign"}</button>
      </form>
      {error && <p role="alert" style={{ color: "crimson" }}>{error}</p>}
      {result && (
        <div aria-live="polite" style={{ marginTop: 16 }}>
          {result.status === "NOT_COLLECTED" && <p>No verified paid windows are stored for this campaign. Nothing can be analysed yet.</p>}
          {result.status === "ACCOUNT_CONFLICT" && (
            <p role="status" style={{ border: "1px solid crimson", padding: 10 }}>
              <strong>Quarantined: stored windows come from different ad accounts</strong> ({result.accountConflict.map((a) => `${a.accountId}: ${a.windows} window(s)`).join("; ")}). No metrics, trend or performance recommendation are shown until provenance is resolved.
            </p>
          )}
          {(quality.length > 0 || result.dataQuality.untrustedWindows > 0) && (
            <div role="status" style={{ border: "1px solid crimson", padding: 10 }}>
              <strong>Data-quality warnings — review before relying on any metric</strong>
              <ul>
                {result.dataQuality.untrustedWindows > 0 && <li>{result.dataQuality.untrustedWindows} stored window(s) failed provenance checks and were excluded.</li>}
                {quality.map((a) => <li key={a.code}>{label(a.code)}: {a.detail}</li>)}
              </ul>
            </div>
          )}
          {result.dataQuality.overlappingWindowsExcluded > 0 && <p>{result.dataQuality.overlappingWindowsExcluded} overlapping window(s) excluded from the trend.</p>}
          {result.windows.length > 0 && (
            <table>
              <caption>Stored paid windows (newest first, EUR)</caption>
              <thead><tr><th>Window</th><th>Spend</th><th>Impressions</th><th>Clicks</th><th>CTR</th><th>CPC</th><th>CPM</th></tr></thead>
              <tbody>
                {result.windows.map((w) => (
                  <tr key={w.period.end}>
                    <td>{w.period.start} — {w.period.end}</td><td>{eur(w.spendEur)}</td><td>{num(w.impressions)}</td><td>{num(w.clicks)}</td>
                    <td>{pct(w.rates.ctr)}</td><td>{eur(w.rates.cpcEur, 4)}</td><td>{eur(w.rates.cpmEur, 4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {result.trend && <p>Latest vs previous window (per day): spend {change(result.trend.spendPerDayChange)}, CTR {change(result.trend.ctrChange)}, CPC {change(result.trend.cpcChange)}, CPM {change(result.trend.cpmChange)}.</p>}
          {performance.length > 0 && <ul aria-label="Performance anomalies">{performance.map((a) => <li key={a.code}>{label(a.code)}: {a.detail}</li>)}</ul>}
          <h3>Advisory recommendations</h3>
          <ul>{result.recommendations.map((r) => <li key={r.code}><strong>{label(r.code)}</strong> — {r.reason}</li>)}</ul>
          <p>Marketplace ROAS: <strong>not computed</strong> (no verified eBay/Etsy attribution).</p>
          <p style={{ fontWeight: 600 }}>Advisory only: no budget, bid or campaign change is made or authorized.</p>
        </div>
      )}
    </section>
  );
}
