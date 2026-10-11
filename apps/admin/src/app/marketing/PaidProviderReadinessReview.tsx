"use client";

import { useState } from "react";
import { api } from "../../lib/api";

type ProviderReadiness = {
  platform: "meta" | "google_ads" | "pinterest_ads";
  status: "NOT_CONFIGURED" | "CONFIG_REVIEW_REQUIRED";
  configured: boolean;
  requiredChecks: string[];
  connectionVerified: false;
  campaignsEnabled: false;
  spendAuthorized: false;
};
type Readiness = {
  providers: ProviderReadiness[];
  campaignsEnabled: false;
  spendAuthorized: false;
};
const names: Record<ProviderReadiness["platform"], string> = {
  meta: "Meta Ads",
  google_ads: "Google Ads",
  pinterest_ads: "Pinterest Ads",
};

/**
 * ADS-006G: existing Analytics API reports server-side paid credential
 * configuration presence, NOT true account connectivity or permission to spend.
 * Organic Instagram/Pinterest connections have no bearing on this status.
 */
export function PaidProviderReadinessReview() {
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  async function refresh() {
    setError(null);
    setReadiness(null);
    setLoading(true);
    try {
      const result = await api.get<Readiness>("/api/analytics/ads/providers/readiness");
      if (result.campaignsEnabled !== false || result.spendAuthorized !== false
        || !Array.isArray(result.providers) || result.providers.length !== 3
        || new Set(result.providers.map(p => p.platform)).size !== 3
        || result.providers.some(p => !p || typeof p !== "object"
          || !Object.prototype.hasOwnProperty.call(names, p.platform)
          || typeof p.configured !== "boolean"
          || p.status !== (p.configured ? "CONFIG_REVIEW_REQUIRED" : "NOT_CONFIGURED")
          || p.connectionVerified !== false || p.campaignsEnabled !== false
          || p.spendAuthorized !== false || !Array.isArray(p.requiredChecks)
          || p.requiredChecks.length > 10
          || p.requiredChecks.some(check => typeof check !== "string"
            || check.length > 240))) {
        throw new Error("Unexpected paid account readiness response. Nothing has been enabled.");
      }
      setReadiness(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to check paid account readiness.");
    } finally {
      setLoading(false);
    }
  }
  return (
    <section style={{borderTop:"1px solid #8b6b2e",marginTop:32,paddingTop:20}} aria-label="Paid ads provider connection readiness">
      <h2>Paid Ads accounts — connection checklist</h2>
      <p>
        This does not connect an ad account or grant new permissions. Existing organic
        Instagram/Pinterest links do not authorize paid advertising.
        Configured credentials are not proof that a provider account is verified.
      </p>
      <button type="button" onClick={() => void refresh()} disabled={loading} style={{padding:10}}>
        {loading ? "Checking…" : "Check paid account readiness"}
      </button>
      {error && <p role="alert" style={{color:"crimson"}}>{error}</p>}
      {readiness && (
        <div aria-live="polite">
          <p style={{fontWeight:700}}>Paid publishing and spending: DISABLED</p>
          <ul style={{display:"grid",gap:20,paddingLeft:22}}>
            {readiness.providers.map(p => (
              <li key={p.platform}>
                <strong>{names[p.platform]}: {p.status.replaceAll("_"," ")}</strong>
                <p>
                  Server config present: {p.configured ? "Yes — still requires account review" : "No"}.
                  Provider connection verified: NO. Spending authorized: NO.
                </p>
                <ul>{p.requiredChecks.map(check => <li key={check}>{check}</li>)}</ul>
              </li>
            ))}
          </ul>
          <p>Account setup should be performed in the provider business interface.
            Do not paste passwords, access tokens, or developer keys into this screen.</p>
        </div>
      )}
    </section>
  );
}
