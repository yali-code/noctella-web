"use client";

import { resolveApiAssetUrl } from "@/lib/api";
import { buildEtsyMediaPlan, type EtsyPhotoCandidate, type EtsyMediaIssue } from "@/lib/etsyMediaPlan";

interface EtsyMediaPreviewProps {
  photos: readonly EtsyPhotoCandidate[];
  loading?: boolean;
  error?: boolean;
}

function issueMessage(issue: EtsyMediaIssue): string {
  switch (issue.code) {
    case "MISSING_PRIMARY": return "No eligible primary image. Select a Ready primary photo in photo management.";
    case "MULTIPLE_PRIMARIES": return "Multiple eligible primary images. Resolve the primary selection in photo management.";
    case "DUPLICATE_PHOTO_ID": return "Duplicate photo identities. Preview images are hidden until canonical photo identities are resolved.";
    case "EXCLUDED_INCOMPLETE": return `${issue.count} photo(s) excluded because they are not Ready, have no image URL, or have an unsafe display URL.`;
    case "UNSAFE_IMAGE_URL": return "A photo was excluded because its image or thumbnail URL is unsafe.";
    case "IMAGE_LIMIT": return `${issue.count} eligible photo(s) exceed Etsy's 20-image preview limit. Canonical photos are unchanged.`;
    case "MISSING_ALT_TEXT": return "An image has missing alt text.";
    case "ALT_TEXT_TOO_LONG": return "An image has alt text exceeding 500 Unicode code points.";
  }
}

/** Display only: receives canonical photo reads; no provider or mutation operations. */
export function EtsyMediaPreview({ photos, loading = false, error = false }: EtsyMediaPreviewProps) {
  // Never present stale eligibility while a fresh product read is pending or failed.
  const plan = loading || error ? null : buildEtsyMediaPlan(photos);
  const generalIssues = plan?.issues.filter(issue => issue.code !== "MISSING_ALT_TEXT" && issue.code !== "ALT_TEXT_TOO_LONG") ?? [];
  const duplicate = plan?.issues.some(issue => issue.code === "DUPLICATE_PHOTO_ID");
  const incompleteCount = photos.filter(photo => photo.processingStatus !== "Ready").length;

  return (
    <section aria-label="Etsy Media Preview" className="noctella-panel" style={{ padding: 20, margin: "20px 0", minWidth: 0, overflowWrap: "anywhere" }}>
      <h2>Etsy Media Preview</h2>
      <p><strong>Read only — not published or synced to Etsy.</strong></p>
      <p>Media eligibility only. Etsy listing fields and full publishing readiness are checked separately.</p>
      <p>Uses canonical photos from the last product read; unsaved photo or form edits are not included.</p>
      {loading ? <p role="status">Loading Etsy media preview…</p> : error ? (
        <p role="alert">Etsy media preview unavailable. Reload the product to try again.</p>
      ) : plan && <>
        <p role="status">{plan.ready ? "Eligible for media preview" : "Media preview needs attention"} · {plan.eligibleCount} eligible photo(s)</p>
        {photos.length === 0 && <p>No canonical photos yet.</p>}
        {incompleteCount > 0 && <p>{incompleteCount} Processing, Failed, or unclassified photo(s) excluded.</p>}
        {generalIssues.length > 0 && <ul aria-label="Etsy media warnings">
          {generalIssues.map((issue, index) => (
            <li key={`${issue.code}-${index}`}>{issueMessage(issue)}</li>
          ))}
        </ul>}
        {!duplicate && plan.media.length > 0 && <ol aria-label="Etsy candidate images" style={{ listStyle: "none", padding: 0, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: 16 }}>
          {plan.media.map(photo => <li key={photo.photoId} style={{ minWidth: 0 }}>
            <figure style={{ margin: 0 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={resolveApiAssetUrl(photo.thumbnailUrl || photo.url)} alt={photo.altText} loading="lazy" style={{ display: "block", width: "100%", maxWidth: 320, aspectRatio: "1", objectFit: "contain" }} />
              <figcaption>
                <strong>Etsy rank {photo.etsyRank}{photo.isPrimary ? " — Primary image" : ""}</strong>
                <p>Alt text: {photo.altText.trim() ? photo.altText : "Missing"}</p>
                <p>{photo.altTextLength} / 500 Unicode code points</p>
                {photo.warnings.length > 0 && <ul aria-label={`Warnings for Etsy rank ${photo.etsyRank}`}>
                  {photo.warnings.map(code => <li key={code}>{issueMessage({ code })}</li>)}
                </ul>}
              </figcaption>
            </figure>
          </li>)}
        </ol>}
      </>}
    </section>
  );
}
