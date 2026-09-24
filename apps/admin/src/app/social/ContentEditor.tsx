"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { SOCIAL_CONTENT_TYPES, type SocialContent, type SocialContentDraftInput, type SocialContentStatus } from "@noctella/shared";
import { socialContentApi } from "@/lib/socialContent";
import { ApiError, resolveApiAssetUrl } from "@/lib/api";
import { ProductMediaPicker } from "./ProductMediaPicker";
import { control, grid, panel, statusLabel } from "./styles";

export function ContentEditor({ id, initialProductId = null, initialMediaIds = [] }: { id?: string; initialProductId?: string | null; initialMediaIds?: string[] }) {
  const router = useRouter();
  const [record, setRecord] = useState<SocialContent | null>(null);
  const [input, setInput] = useState<SocialContentDraftInput>({ contentType: "post", caption: "", productId: initialProductId, mediaIds: initialMediaIds });
  const [loading, setLoading] = useState(!!id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const editable = !record || record.status === "draft";
  useEffect(() => {
    if (!id) return;
    let active = true;
    setLoading(true);
    socialContentApi.get(id).then((value) => {
      if (active) { setRecord(value); setInput({ contentType: value.contentType, caption: value.caption, productId: value.productId, mediaIds: value.media.map((photo) => photo.id) }); }
    }).catch(() => { if (active) setError("Content could not be loaded."); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id]);
  async function act(status?: SocialContentStatus) {
    setBusy(true); setError(""); setMessage("");
    try {
      let value = record;
      if (editable) value = record ? await socialContentApi.edit(record.id, input, record.version) : await socialContentApi.create(input);
      if (!value) return;
      setRecord(value);
      if (status) { value = await socialContentApi.transition(value.id, status, value.version); setRecord(value); }
      setMessage(status ? "Status updated." : "Draft saved.");
      if (!id) router.push(`/social/${value.id}`);
    } catch (err) { setError(err instanceof ApiError ? err.message : "Content could not be saved. Reload and try again."); }
    finally { setBusy(false); }
  }
  if (loading) return <p role="status">Loading content…</p>;
  if (id && !record) return <p role="alert">{error}</p>;
  return <section><h2>{id ? "Content detail" : "Create content"}</h2>
    <p>Instagram · @noctella.vault</p><p>Status: {statusLabel(record?.status ?? "draft")}</p>
    {record && <p>Created: {new Date(record.createdAt).toLocaleString()} · Updated: {new Date(record.updatedAt).toLocaleString()}</p>}
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {!!record?.missingMediaCount && <p role="alert">Some selected media is no longer available. Review the media selection before approval.</p>}
    {record?.status === "approved" && <p>Approved — read-only. Approval does not publish or schedule content.</p>}
    <fieldset disabled={busy || !editable} style={{ border: 0, padding: 0, minWidth: 0 }}>
      <div className="noctella-panel" style={panel}>
        <label>Content type <select style={control} value={input.contentType} onChange={(e) => setInput({ ...input, contentType: e.target.value as SocialContentDraftInput["contentType"] })}>{SOCIAL_CONTENT_TYPES.map((type) => <option key={type}>{type}</option>)}</select></label>
        <p>Post, reel and story drafts are for planning and review only.</p>
        <label style={{ display: "grid", gap: 8 }}>Caption<textarea style={control} rows={6} maxLength={2200} value={input.caption} onChange={(e) => setInput({ ...input, caption: e.target.value })} /></label>
        <p>{input.caption.length}/2200 characters</p>
      </div>
      {editable && <ProductMediaPicker productId={input.productId} mediaIds={input.mediaIds} onChange={(productId, mediaIds) => setInput({ ...input, productId, mediaIds })} />}
    </fieldset>
    {!editable && record && <section className="noctella-panel" style={panel}><h3>{record.product ? `${record.product.sku} · ${record.product.title}` : "No selected product"}</h3>
      {!record.media.length && <p>No media available.</p>}<div style={grid}>{record.media.map((photo) => <img key={photo.id} src={resolveApiAssetUrl(photo.url)} alt={photo.altText || "Selected product photo"} style={{ width: "100%", height: 180, objectFit: "contain" }} />)}</div>
    </section>}
    <div style={{ display: "flex", gap: 12 }}>
      {editable && <><button style={control} disabled={busy} onClick={() => act()}>Save draft</button><button style={control} disabled={busy || !input.caption.trim() || !input.mediaIds.length} onClick={() => act("ready_for_review")}>Submit for review</button></>}
      {record?.status === "ready_for_review" && <><button style={control} disabled={busy} onClick={() => act("approved")}>Approve</button><button style={control} disabled={busy} onClick={() => act("rejected")}>Reject</button></>}
      {record?.status === "rejected" && <button style={control} disabled={busy} onClick={() => act("draft")}>Return to draft</button>}
    </div>
  </section>;
}
