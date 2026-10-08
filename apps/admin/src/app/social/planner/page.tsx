"use client";
import { useCallback, useEffect, useState } from "react";
import { resolveApiAssetUrl } from "@/lib/api";
import { mediaPlannerApi, type MediaPlan, type MediaPlanItem, type MediaPlannerReadiness } from "@/lib/mediaPlanner";
import { control, panel, statusLabel } from "../styles";

/**
 * Media Planning Agent - owner review. The planner proposes a 4-day plan; the owner edits and
 * approves; scheduling hands approved feed posts to the existing Social Agent publishing chain.
 * Nothing on this page publishes directly.
 */
const toLocalInput = (iso: string) => { const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };

function ItemEditor({ plan, item, editable, onSaved, onError }: { plan: MediaPlan; item: MediaPlanItem; editable: boolean; onSaved: (p: MediaPlan) => void; onError: (m: string) => void }) {
  const [caption, setCaption] = useState(item.caption);
  const [hashtags, setHashtags] = useState(item.hashtags.join(" "));
  const [plannedAt, setPlannedAt] = useState(toLocalInput(item.plannedAt));
  const [productId, setProductId] = useState(item.product.id);
  const [heroPhotoId, setHeroPhotoId] = useState(item.heroPhotoId);
  useEffect(() => { setCaption(item.caption); setHashtags(item.hashtags.join(" ")); setPlannedAt(toLocalInput(item.plannedAt)); setProductId(item.product.id); setHeroPhotoId(item.heroPhotoId); }, [item]);
  const save = async () => {
    try {
      const productChanged = productId !== item.product.id;
      onSaved(await mediaPlannerApi.editItem(plan.id, item.id, {
        expectedVersion: item.version, caption, hashtags: hashtags.split(/\s+/).filter(Boolean), plannedAt: new Date(plannedAt).toISOString(),
        ...(productChanged ? { productId } : item.contentType === "FEED_POST" && heroPhotoId !== item.heroPhotoId ? { photoIds: [heroPhotoId], heroPhotoId } : {}),
      }));
    } catch (e) { onError(e instanceof Error ? e.message : "Save failed"); }
  };
  return <article className="card" style={panel}>
    <h3>{item.contentType === "REEL" ? "Reel" : `Feed post (${statusLabel(item.postFormat)})`} · {new Date(item.plannedAt).toLocaleString()} <small>({statusLabel(item.timeBasis)})</small></h3>
    <p><strong>{item.product.title}</strong> · {item.product.sku} · {item.product.category ?? "Uncategorised"} · status {statusLabel(item.status)}</p>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {item.photos.map((p) => p.url ? <button key={p.id} type="button" disabled={!editable || item.contentType === "REEL"} onClick={() => setHeroPhotoId(p.id)} style={{ border: p.id === heroPhotoId ? "2px solid var(--noctella-antique-gold)" : "1px solid transparent", padding: 0, background: "none" }}>
        <img src={resolveApiAssetUrl(p.url)} alt="" width={96} height={96} style={{ objectFit: "cover" }} /></button> : null)}
    </div>
    {item.reel ? <div style={{ marginTop: 12 }}>
      <p>Reel: {statusLabel(item.reel.status ?? "pending")}{item.hook ? ` · hook “${item.hook}”` : ""}</p>
      {item.reel.previewPath ? <video src={resolveApiAssetUrl(item.reel.previewPath)} controls muted crossOrigin="use-credentials" style={{ maxHeight: 360 }} /> : null}
      {editable && item.reel.status !== "RENDERED" ? <button type="button" style={control} onClick={async () => { try { onSaved(await mediaPlannerApi.renderReel(plan.id, item.id)); } catch (e) { onError(e instanceof Error ? e.message : "Render failed"); } }}>Render Reel</button> : null}
    </div> : null}
    <label>Product ID<input style={control} value={productId} disabled={!editable} onChange={(e) => setProductId(e.target.value)} /></label>
    <label>Caption<textarea style={{ ...control, width: "100%", minHeight: 100 }} value={caption} disabled={!editable} onChange={(e) => setCaption(e.target.value)} /></label>
    <label>Hashtags<input style={{ ...control, width: "100%" }} value={hashtags} disabled={!editable} onChange={(e) => setHashtags(e.target.value)} /></label>
    <label>Posting time<input type="datetime-local" style={control} value={plannedAt} disabled={!editable} onChange={(e) => setPlannedAt(e.target.value)} /></label>
    <p><small>{item.rationale}</small></p>
    {editable ? <button type="button" style={control} onClick={save}>Save changes</button> : null}
  </article>;
}

export default function MediaPlannerPage() {
  const [readiness, setReadiness] = useState<MediaPlannerReadiness | null>(null);
  const [plan, setPlan] = useState<MediaPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try { setReadiness(await mediaPlannerApi.readiness()); setPlan((await mediaPlannerApi.latest()).plan); } catch (e) { setError(e instanceof Error ? e.message : "Load failed"); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const act = async (fn: () => Promise<MediaPlan>) => { setBusy(true); setError(null); try { setPlan(await fn()); setReadiness(await mediaPlannerApi.readiness()); } catch (e) { setError(e instanceof Error ? e.message : "Action failed"); } finally { setBusy(false); } };
  const editable = plan?.status === "READY_FOR_REVIEW";

  return <section>
    <h2>Media Planner · 4-day Instagram plan</h2>
    {error ? <p role="alert">{error}</p> : null}
    {readiness ? <div className="card" style={panel}>
      <p>Eligible products: {readiness.eligibleProductCount}/{readiness.requiredProductCount} · Instagram publishing {readiness.instagramPublishingReady ? "ready" : "not ready"} · Reel renderer {readiness.ffmpegAvailable ? `ready (${readiness.ffmpegSource})` : "unavailable"} · Video delivery {readiness.publicVideoDeliveryReady ? "ready" : "not ready"} · Copy {readiness.copyProvider}</p>
      <p>Scheduled: {readiness.feedPostsScheduled}/4 feed posts · Reel {readiness.reelScheduled ? "scheduled" : "not scheduled"} · {readiness.ready ? "Pilot ready" : readiness.technicallyReady ? "Technically ready" : "Not ready"}</p>
      {readiness.blockers.length ? <p>Blockers: {readiness.blockers.map(statusLabel).join(", ")}</p> : <p>No blockers.</p>}
    </div> : null}
    <p>
      <button type="button" style={control} disabled={busy} onClick={() => act(() => mediaPlannerApi.generate())}>Generate new plan</button>{" "}
      {plan && editable ? <><button type="button" style={control} disabled={busy} onClick={() => act(() => mediaPlannerApi.approve(plan.id))}>Approve plan</button>{" "}
        <button type="button" style={control} disabled={busy} onClick={() => act(() => mediaPlannerApi.reject(plan.id))}>Reject plan</button></> : null}{" "}
      {plan && (plan.status === "APPROVED" || plan.status === "SCHEDULED") ? <button type="button" style={control} disabled={busy} onClick={() => act(() => mediaPlannerApi.schedule(plan.id))}>Hand off to Social Agent (schedule)</button> : null}
    </p>
    {plan ? <>
      <p>Plan {plan.startDate} → {plan.endDate} ({plan.timezone}) · status <strong>{statusLabel(plan.status)}</strong> · copy {plan.copySource} · {statusLabel(plan.timeRecommendation)}</p>
      {Object.values(plan.rationale).map((line) => <p key={line}><small>{line}</small></p>)}
      {plan.items.map((item) => <ItemEditor key={item.id} plan={plan} item={item} editable={editable} onSaved={setPlan} onError={setError} />)}
    </> : <p>No plan yet.</p>}
  </section>;
}
