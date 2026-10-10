"use client";

import { useRef, useState, type FormEvent } from "react";
import { api } from "../../lib/api";

type Provider = "meta" | "google_ads" | "pinterest_ads";
type Draft = {
  provider: Provider; productId: string; objective: string; status: "DRAFT";
  destination: { marketplace: string; url: string };
  creative: { format: string; headline: string; primaryText: string; callToAction: string; mediaPhotoIds: string[] };
  targeting: { keywordHints: string[]; categoryHint: string | null; geography: null; demographics: null; ownerMustConfirm: true };
  budget: { currency: "EUR"; proposedDailyEur: number | null; hardDailyLimitEur: number; hardTotalLimitEur: number; guardDecision: string };
  notes: string[];
};
type DraftEntry = {
  draft: Draft; fingerprint: string;
  validation: { valid: boolean; errors: string[]; executionBlockers: string[]; executionEnabled: false; spendAuthorized: false };
  approval: { status: string; executionAuthorized: false; spendAuthorized: false };
};
type Preview = {
  productId: string; provider: Provider; scope: "DRAFT_PREVIEW_ONLY";
  media: { selected: { photoId: string; url: string }[]; excluded: { photoId: string; reason: string }[] };
  drafts: DraftEntry[]; capabilityLimitsSource: string;
  ownerApprovalRecorded: false; executionEnabled: false; spendAuthorized: false;
};
const eurPattern = /^(0|[1-9][0-9]{0,5})(\.[0-9]{1,2})?$/;
const label = (code: string) => code.replaceAll("_", " ").toLowerCase();

/**
 * ADS-008: read-only provider campaign draft preview. There is deliberately NO approve button:
 * approvals cannot be stored yet (schema decision pending), so the UI must not imply they are.
 */
export function CampaignDraftPreviewReview() {
  const [productId, setProductId] = useState("");
  const [provider, setProvider] = useState<Provider>("meta");
  const [daily, setDaily] = useState("2");
  const [dailyCap, setDailyCap] = useState("5");
  const [totalCap, setTotalCap] = useState("20");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Only the latest request may update the screen; any input change invalidates the shown preview
  // and every in-flight request, so a draft never appears with budgets or a product it was not built for.
  const requestSeq = useRef(0);
  const invalidate = () => { requestSeq.current += 1; setPreview(null); setError(null); setLoading(false); };

  async function load(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    invalidate();
    const id = productId.trim();
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) { setError("Enter a valid ERP product ID."); return; }
    if (![daily, dailyCap, totalCap].every((v) => eurPattern.test(v) && Number(v) > 0)) { setError("Budgets must be positive EUR amounts with at most two decimals."); return; }
    const seq = requestSeq.current;
    const requested = { provider, dailyCap: Number(dailyCap), totalCap: Number(totalCap) };
    setLoading(true);
    try {
      const query = new URLSearchParams({ provider, requestedDailyEur: daily, hardDailyLimitEur: dailyCap, hardTotalLimitEur: totalCap });
      const r = await api.get<Preview>(`/api/analytics/ads/campaign-draft/${encodeURIComponent(id)}?${query.toString()}`);
      if (seq !== requestSeq.current) return;
      // Refuse any response that implies a recorded approval, execution or spend authority,
      // or that was not built for exactly the requested product, provider and caps.
      if (r.productId !== id || r.provider !== requested.provider || r.scope !== "DRAFT_PREVIEW_ONLY" || !Array.isArray(r.drafts)
        || r.ownerApprovalRecorded !== false || r.executionEnabled !== false || r.spendAuthorized !== false
        || r.drafts.some((d) => d.validation.executionEnabled !== false || d.validation.spendAuthorized !== false
          || d.approval.executionAuthorized !== false || d.approval.spendAuthorized !== false || d.draft.status !== "DRAFT"
          || d.draft.provider !== requested.provider || d.draft.budget.hardDailyLimitEur !== requested.dailyCap || d.draft.budget.hardTotalLimitEur !== requested.totalCap)) {
        throw new Error("Unexpected campaign draft response. Nothing displayed.");
      }
      setPreview(r);
    } catch (cause) {
      if (seq !== requestSeq.current) return;
      setError(cause instanceof Error ? cause.message : "Campaign draft preview unavailable.");
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }

  return (
    <section aria-label="Campaign draft preview" style={{ marginTop: 36, borderTop: "1px solid #8b6b2e", paddingTop: 22 }}>
      <h2>Provider campaign draft — preview only</h2>
      <p>Builds a provider-specific draft from the ERP product, its Ready photos and the existing budget guard. Nothing is sent to any ad platform.</p>
      <form onSubmit={load} style={{ display: "flex", flexWrap: "wrap", alignItems: "end", gap: 12 }}>
        <label>Draft product ID<input aria-label="Draft product ID" value={productId} onChange={(e) => { setProductId(e.target.value); invalidate(); }} maxLength={100} style={{ display: "block", padding: 10 }} /></label>
        <label>Draft platform
          <select aria-label="Draft platform" value={provider} onChange={(e) => { setProvider(e.target.value as Provider); invalidate(); }} style={{ display: "block", padding: 10 }}>
            <option value="meta">Meta Ads</option><option value="google_ads">Google Ads</option><option value="pinterest_ads">Pinterest Ads</option>
          </select>
        </label>
        <label>Requested daily €<input aria-label="Draft requested daily EUR" value={daily} onChange={(e) => { setDaily(e.target.value); invalidate(); }} inputMode="decimal" style={{ display: "block", padding: 10 }} /></label>
        <label>Daily cap €<input aria-label="Draft daily cap EUR" value={dailyCap} onChange={(e) => { setDailyCap(e.target.value); invalidate(); }} inputMode="decimal" style={{ display: "block", padding: 10 }} /></label>
        <label>Total cap €<input aria-label="Draft total cap EUR" value={totalCap} onChange={(e) => { setTotalCap(e.target.value); invalidate(); }} inputMode="decimal" style={{ display: "block", padding: 10 }} /></label>
        <button type="submit" disabled={loading} style={{ padding: 12 }}>{loading ? "Building…" : "Preview provider campaign draft"}</button>
      </form>
      {error && <p role="alert" style={{ color: "crimson" }}>{error}</p>}
      {preview && (
        <div aria-live="polite" style={{ marginTop: 16 }}>
          <p>Approved ERP media: {preview.media.selected.length ? preview.media.selected.map((m) => m.photoId).join(", ") : "none"}
            {preview.media.excluded.length > 0 && <> · excluded: {preview.media.excluded.map((m) => `${m.photoId} (${label(m.reason)})`).join(", ")}</>}</p>
          {preview.drafts.length === 0 && <p>No eligible marketplace listing — no draft can be built for this product.</p>}
          {preview.drafts.map((d) => (
            <article key={d.fingerprint} style={{ border: "1px solid #ccc", padding: 12, marginTop: 12 }}>
              <h3>{d.draft.creative.headline}</h3>
              <p>{d.draft.creative.primaryText} · {d.draft.creative.callToAction} → {d.draft.destination.marketplace}</p>
              <p>Format {label(d.draft.creative.format)} · media {d.draft.creative.mediaPhotoIds.join(", ") || "none"}</p>
              <p>Targeting hints (owner must confirm): {d.draft.targeting.keywordHints.join(", ") || "none"} · geography and demographics not set</p>
              <p>Budget: proposed {d.draft.budget.proposedDailyEur === null ? "none" : `€${d.draft.budget.proposedDailyEur.toFixed(2)}/day`} · caps €{d.draft.budget.hardDailyLimitEur.toFixed(2)}/day, €{d.draft.budget.hardTotalLimitEur.toFixed(2)} total · guard {label(d.draft.budget.guardDecision)}</p>
              {d.draft.notes.length > 0 && <p>Notes: {d.draft.notes.map(label).join(", ")}</p>}
              <p>Validation: {d.validation.valid ? "valid draft" : <strong>invalid — {d.validation.errors.map(label).join(", ")}</strong>}</p>
              <dl>
                <dt>Draft approval</dt><dd><strong>Not recorded</strong> — approvals cannot be saved yet ({label(d.approval.status)}).</dd>
                <dt>Execution authorization</dt><dd><strong>Disabled</strong> — {d.validation.executionBlockers.map(label).join(", ")}.</dd>
              </dl>
              <p><small>Content fingerprint {d.fingerprint.slice(0, 12)}… — any edit invalidates a future approval.</small></p>
            </article>
          ))}
          <p><small>Provider limits: {label(preview.capabilityLimitsSource)}.</small></p>
          <p style={{ fontWeight: 600 }}>Preview only: no approval is stored, no campaign is created and no spend is authorized.</p>
        </div>
      )}
    </section>
  );
}
