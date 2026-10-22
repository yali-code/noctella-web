import type { ProductPhoto } from "@noctella/shared";

/** Preview-only selector: never writes ERP records or sends Etsy API requests. */
export type EtsyPhotoCandidate = Pick<ProductPhoto, "id" | "url" | "thumbnailUrl" | "sortOrder" | "isPrimary" | "altText" | "processingStatus">;
export type EtsyMediaIssueCode = "MISSING_PRIMARY" | "MULTIPLE_PRIMARIES" | "DUPLICATE_PHOTO_ID" | "EXCLUDED_INCOMPLETE" | "IMAGE_LIMIT" | "MISSING_ALT_TEXT" | "ALT_TEXT_TOO_LONG" | "UNSAFE_IMAGE_URL";
export interface EtsyMediaIssue { code: EtsyMediaIssueCode; photoId?: string; count?: number }
export interface EtsyMediaPlanPhoto {
  photoId: string;
  url: string;
  thumbnailUrl: string;
  sourceSortOrder: number;
  etsyRank: number;
  isPrimary: boolean;
  altText: string;
  altTextLength: number;
  warnings: EtsyMediaIssueCode[];
}
export interface EtsyMediaPlan {
  media: EtsyMediaPlanPhoto[];
  issues: EtsyMediaIssue[];
  ready: boolean;
  eligibleCount: number;
  truncatedCount: number;
}

/** Reject non-display URLs, protocol-relative URLs and embedded credentials. */
function safeDisplayUrl(value: string): boolean {
  const url = value.trim();
  if (/^\/(?!\/)[^\\]*$/.test(url) && !url.startsWith("/../") && url !== "/..") return true;
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const parsed = new URL(url);
    return !parsed.username && !parsed.password && !parsed.pathname.includes("/../");
  } catch { return false; }
}

const PHOTO_MAX = 20;
const ALT_MAX_CODEPOINTS = 500;

/** Deterministic, immutable canonical-to-Etsy media candidate calculation. */
export function buildEtsyMediaPlan(photos: readonly EtsyPhotoCandidate[]): EtsyMediaPlan {
  const issues: EtsyMediaIssue[] = [];
  const ids = new Set<string>();
  let duplicateId = false;
  for (const photo of photos) {
    if (!photo.id || ids.has(photo.id)) duplicateId = true;
    ids.add(photo.id);
  }
  if (duplicateId) issues.push({ code: "DUPLICATE_PHOTO_ID" });

  const eligible = photos.filter(photo => {
    if (photo.processingStatus !== "Ready" || !photo.url?.trim()) return false;
    if (!safeDisplayUrl(photo.url) || (photo.thumbnailUrl && !safeDisplayUrl(photo.thumbnailUrl))) {
      issues.push({ code: "UNSAFE_IMAGE_URL", photoId: photo.id });
      return false;
    }
    return true;
  });
  const excluded = photos.length - eligible.length;
  if (excluded > 0) issues.push({ code: "EXCLUDED_INCOMPLETE", count: excluded });

  const primaries = eligible.filter(photo => photo.isPrimary);
  if (primaries.length === 0) issues.push({ code: "MISSING_PRIMARY" });
  if (primaries.length > 1) issues.push({ code: "MULTIPLE_PRIMARIES", count: primaries.length });
  const sorted = [...eligible].sort((a, b) =>
    Number(b.isPrimary) - Number(a.isPrimary) ||
    a.sortOrder - b.sortOrder ||
    a.id.localeCompare(b.id, "en"),
  );
  const truncatedCount = Math.max(0, sorted.length - PHOTO_MAX);
  if (truncatedCount) issues.push({ code: "IMAGE_LIMIT", count: truncatedCount });

  const media = sorted.slice(0, PHOTO_MAX).map((photo, index): EtsyMediaPlanPhoto => {
    const altText = photo.altText ?? "";
    const altTextLength = Array.from(altText).length;
    const warnings: EtsyMediaIssueCode[] = [];
    if (!altText.trim()) warnings.push("MISSING_ALT_TEXT");
    if (altTextLength > ALT_MAX_CODEPOINTS) warnings.push("ALT_TEXT_TOO_LONG");
    for (const code of warnings) issues.push({ code, photoId: photo.id });
    return {
      photoId: photo.id,
      url: photo.url,
      thumbnailUrl: photo.thumbnailUrl,
      sourceSortOrder: photo.sortOrder,
      etsyRank: index + 1,
      isPrimary: photo.isPrimary,
      altText,
      altTextLength,
      warnings,
    };
  });

  return { media, issues, ready: !duplicateId && primaries.length === 1, eligibleCount: eligible.length, truncatedCount };
}
