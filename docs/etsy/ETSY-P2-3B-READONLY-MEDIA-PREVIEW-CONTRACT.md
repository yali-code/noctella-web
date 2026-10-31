# Etsy P2-3B — Canonical ProductPhoto read-only media-plan contract

Date: 2026-10-13. **Documentation/specification only**. Follow-on to Draft #378; Phase 1 Draft #371 is not merged. Codex owns P2-2B in #384; this PR must not modify photo upload, processing, Sharp, AI-intake or outbox runtime.

## Source-level contracts verified against `main` at `7df99bad`

- `apps/admin/src/lib/productPhotos.ts`: `productPhotoPublicationReadiness` considers a photo eligible only if `processingStatus === "Ready"` and `url` is truthy; its `ready` requires a ready primary. Admin manages canonical `ProductPhoto` IDs/order/primary/alt.
- `apps/api/src/repositories/product-read/types.ts`: `ProductPhotoReadProjection` includes stable `id`, `sortOrder`, `isPrimary`, `url`, `thumbnailUrl`, `altText`, `processingStatus`, `storageKey` and timestamps. Do not use a product-wide `videoUrl` as if it were an uploaded Etsy listing-video ID.
- `apps/api/src/services/publishing.ts`: `hasEligiblePrimaryPhoto` accepts **Ready or Processing** for general historical publish validation. **This is not the same contract as external Etsy media attachment readiness.** Do not change historical eBay/Web/other publishing policy as a side effect of this preview.
- Draft #378 API note: gallery planning allows at most 20 candidate images, Etsy `rank` starts at 1, alt text guidance max 500 characters, provider IDs are different from canonical IDs. Two-video capability is rollout/feature-gated; P2-3B is image-only.

## Pure function contract (proposed; not implemented here)

Place future isolated selector in an Admin/shared pure module (not in database write services). Input `readonly ProductPhoto[]` + maxImages default 20. Output `{ media: ProposedEtsyPhoto[], issues: PreviewIssue[], ready: boolean, eligibleCount: number, truncatedCount: number }` where each ProposedEtsyPhoto includes canonical `photoId`, `url`, `thumbnailUrl`, `sourceSortOrder`, `etsyRank`, `isPrimary`, `altText`, `altTextLength` and `warnings`. Do not emit provider listing/image IDs or fabricate an upload state.

### Selection and ordering

1. Never mutate input photos or canonical rows. Ignore non-Ready photos, or Ready photos without non-empty `url`, for Etsy attachment candidates. Emit an issue/count for excluded incomplete photos.
2. Require exactly one eligible explicit primary to mark `ready: true`. If none: `ready: false`, explain why. Never silently promote a non-primary photo, including when a primary is Processing/Failed.
3. When one eligible primary exists, place it at `etsyRank: 1`; other eligible photos in ascending `sortOrder` then stable `id` tie-break. Do not assume `sortOrder` globally unique. Rank sequentially 1..N.
4. If multiple eligible primary flags exist (corrupt/legacy data), **fail closed** with a blocking issue; do not pick arbitrarily. Deterministic candidate display may remain for diagnostics but `ready: false`.
5. Cap the preview candidates at 20 *after* ordering and emit excess/truncation count. This is a provider view cap only; retain all canonical photos. Photo selections are not persisted or uploaded.
6. Preserve original alt text in canonical data. On preview, show empty/whitespace missing, excessive (>500 Unicode code points) and potential inaccessible alt warnings. **Do not silently truncate** or rewrite; UI can present the actual value as a warning. Avoid user-visible byte-count confusion (UTF-16 length vs characters) when deciding implementation.
7. URLs must be resolved only through existing safe media-display path, never expose private local filesystem paths, credentials, storage keys or signed provider write URLs to client. Existing `url` is canonical display URL, not an Etsy CDN URL.
8. Optional flags like `eligibleCount` and `missingAltTextCount` must describe *ready candidates*, not all canonical/Processing photos.

### Separate readiness semantics

| Case | Existing generic publishing check | P2-3B Etsy attachment preview |
|---|---|---|
| Explicit primary **Ready**, usable URL | Eligible | Eligible |
| Explicit primary **Processing** | Can be eligible by historical general publish rule | Not attachable; `ready=false` |
| Explicit primary **Failed** | Not eligible | Not attachable |
| Non-primary Ready only | No explicit primary, not eligible | Show candidates, `ready=false`; no fallback promotion |
| Two Ready explicit primaries | Generic predicate sees primary | Block ambiguity; `ready=false` |
| 21 Ready photos | Generic predicate may pass | Only 20 planned; preserve remaining ERP photos |

Do not alter generic `validatePublish` as part of the selector. Attachment-level strictness does **not** automatically mean the current system should fail or allow listing publication differently. Actual Etsy provider readiness gate and reconciliation will be specified in separate approved feature work.

## P2-3B proposed test matrix

- Empty; one Ready primary; one Processing primary + Ready others; Failed primary; Ready without URL; missing explicit primary.
- Primary with later `sortOrder` still gets rank 1; stable ties sorted by ID; immutable frozen inputs and unchanged original list.
- Duplicate primary flags fail closed; duplicate IDs report invalid/ambiguous input rather than emitting provider operations.
- Exactly 20, 21 and 50 Ready candidates; only 20 in output; stable `truncatedCount`.
- Null, blank, 500-codepoint and 501-codepoint alt texts; Unicode surrogate pairs and accessibility warnings.
- Non-Ready photos excluded; no product photo creation, update, delete, reorder, provider fetch or publication called.
- No leakage of storageKey/thumbnailStorageKey to client or unsafe URL handling.
- Existing Admin photo reorder/capabilities/publication readiness and API publish validation regressions remain unchanged.

## Dependencies and approval gates

- P2-3B implementation should be a **new isolated Draft PR** based on latest approved integration baseline. If Phase 1 (#371) remains unmerged, keep selector pure and UI integration separate; avoid changing #371 files.
- Any Etsy video workflow, provider mapping table, write-capable sync, OAuth scopes, new limits on canonical photos or actual listing activation require a separately authorized stage.
- Re-run combination tests after selected PRs merge. Green isolated PR CI does not guarantee integration compatibility.
- No merge/deploy/production/provider calls are authorized here.
