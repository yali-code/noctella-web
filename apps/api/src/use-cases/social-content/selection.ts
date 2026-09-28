import { ProductStatus } from "@noctella/shared";
import type { SocialContentRepository } from "../../repositories/social-content/types";

export interface SocialContentCandidate {
  productId: string;
  title: string;
  readyPhotoCount: number;
  latestSocialActivityAt: string | null;
  latestSocialStatus: string | null;
  reason: "never_used" | "oldest_activity";
}

// Candidate discovery is not publication approval. Preparatory statuses remain eligible
// for human review; archived or unavailable (reserved/sold/returned) stock is excluded.
const eligible = new Set<string>([ProductStatus.Draft, ProductStatus.AiPrepared, ProductStatus.PendingReview, ProductStatus.Approved, ProductStatus.Published]);
// Approved is editorial-terminal, not proof of publication. No trustworthy completion
// relationship exists yet, so it blocks repeat selection. Rejected work is closed for selection.
const unresolved = new Set(["draft", "ready_for_review", "approved"]);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export async function selectNextSocialContentProduct(repo: SocialContentRepository): Promise<SocialContentCandidate | null> {
  const rows = await repo.transaction(function* (tx) { return yield* repo.readSelectionRows(tx); });
  const candidates = new Map<string, SocialContentCandidate>();
  const blocked = new Set<string>();
  const latestIds = new Map<string, string>();
  for (const row of rows) {
    if (!eligible.has(row.productStatus) || row.readyPhotoCount < 1) continue;
    let candidate = candidates.get(row.productId);
    if (!candidate) {
      candidate = { productId: row.productId, title: row.title, readyPhotoCount: Number(row.readyPhotoCount),
        latestSocialActivityAt: null, latestSocialStatus: null, reason: "never_used" };
      candidates.set(row.productId, candidate);
    }
    if (!row.contentId) continue;
    if (unresolved.has(row.contentStatus ?? "")) blocked.add(row.productId);
    // SQLite legacy timestamps are UTC without an offset; PostgreSQL returns Date.
    const raw = row.activityAt;
    const time = raw instanceof Date ? raw.getTime() : Date.parse(raw && !/[zZ]|[+-]\d\d:\d\d$/.test(raw) ? raw.replace(" ", "T") + "Z" : raw ?? "");
    if (!Number.isFinite(time)) { blocked.add(row.productId); continue; }
    const iso = new Date(time).toISOString();
    if (!candidate.latestSocialActivityAt || iso > candidate.latestSocialActivityAt ||
        (iso === candidate.latestSocialActivityAt && compare(row.contentId, latestIds.get(row.productId) ?? "") > 0)) {
      candidate.latestSocialActivityAt = iso; candidate.latestSocialStatus = row.contentStatus;
      candidate.reason = "oldest_activity"; latestIds.set(row.productId, row.contentId);
    }
  }
  return [...candidates.values()].filter((item) => !blocked.has(item.productId)).sort((a, b) =>
    Number(a.latestSocialActivityAt !== null) - Number(b.latestSocialActivityAt !== null) ||
    compare(a.latestSocialActivityAt ?? "", b.latestSocialActivityAt ?? "") ||
    b.readyPhotoCount - a.readyPhotoCount || compare(a.productId, b.productId))[0] ?? null;
}
