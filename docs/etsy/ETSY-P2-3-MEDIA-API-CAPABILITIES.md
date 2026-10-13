# Etsy Phase 2 / P2-3 — Media API capability and read-only preview contract

Date: 2026-10-13 (Europe/Sofia). **Documentation only; no provider calls, OAuth, publication, migration, DB change or upload code.**
Base: `main` at `7df99bad74c822e13a690f7a3593637794b7b7c8`.
Related: P2-1 #373 (Claude benchmark in local checkout, not yet pushed), P2-2 #377 (blocked on benchmark), Phase 1 Draft #371, media audit #369, safety plan #372, storage ADR #375, bounded recovery Draft #376.

## Primary sources checked 2026-10-13

1. Etsy API v3 Reference: https://developer.etsy.com/documentation/reference
2. Etsy Listings Tutorial: https://developer.etsy.com/documentation/tutorials/listings/

The following are **documented API capabilities**, not evidence that Noctella's connected Etsy shop has authorized tokens, live media privileges or an operational integration.

| Capability | Verified public API fact | Planning implication |
|---|---|---|
| Listing image upload | `uploadListingImage`, POST `/shops/{shop_id}/listings/{listing_id}/images`, multipart `image` or existing `listing_image_id`; `listings_w` OAuth for writes | No calls in P2-3; design reversible mapping of canonical photo ID -> Etsy listing image ID |
| Image ordering | `rank` on image upload (API rank 1 first), `overwrite` and `alt_text` (max 500 chars) exposed | Read-only preview can show proposed rank/alt text; never mutate canonical order |
| Image lookup | `getListingImages`, `getListingImage` return provider IDs/rank/URLs; freshly uploaded dimensions can be asynchronous | Reconcile provider state later with retries instead of assuming immediate complete metadata |
| Image count | `image_ids` accepts up to 20 images in listing draft/update reference | UI may show 20-image planning limit; verify product-specific/channel constraints before provider write |
| Draft / active | Tutorial: create draft and attach images; active listing must have at least one image | Preview may warn when no ready primary image; no auto-activation |
| Listing video | `uploadListingVideo` and `getListingVideos` documented; 2-active-video opt-in `is_multi_video=true` | Feature gate multi-video; do not infer general availability from UI |
| **Multi-video transition** | Etsy tutorial states **2026-09-21 to 2026-10-21** transition; omit `is_multi_video` and legacy one-video replacement behavior remains in transition, setting true opts in; third active video yields 409 | **As of 2026-10-13, the transition is ongoing**; avoid unconditional two-video support. Verify rollout and query parameter on connected shop before implementing actual writes |
| Video gallery order | Etsy shows video 1 after main image, video 2 at gallery end | Read-only preview should represent Etsy-specific display layout rather than blindly interleaving media |
| OAuth | Tutorial requires `listings_r` and `listings_w` for listing management; deletion requires `listings_d` | Design least-privilege permissions and defer authorization to owner-approved integration |

**Not confirmed:** API support for editing an Etsy-specific thumbnail crop; upload video format/size/duration limits; detailed asset-rate/quotas; connected-shop video rollout; all provider error/retry semantics. Do not implement these as verified API features. Seller form evidence is not an API contract.

## Proposed P2-3 read-only preview (implementation only after Phase 1 interface stability)

- Start with existing canonical `ProductPhoto` array and stable photo IDs. Exclude not-ready photos and disclose processing/failed status; preserve canonical primary, order, alt text and URL. Preview never changes ProductPhoto rows.
- Derive an Etsy candidate ordering with primary image at rank 1 and other ready images in canonical sort order. Explicitly indicate when there are more than 20 candidate photos, but **do not delete or constrain** canonical ERP photos.
- Show up to 20 image previews, proposed Etsy rank, canonical photo ID, primary flag, alt text length/trim-warning (500 max) and readiness. Do not infer silent replacements/overwrites.
- Distinguish **preview/media planning** from **provider assignment**. No Etsy-specific DB table until mapping/idempotency/reconciliation design approved. Provider image IDs must not be confused with local ProductPhoto IDs.
- Video is a separate asset kind (not Instagram Reel output by default). Show unsupported/unverified capability labels and no upload or publish buttons in P2-3.
- Media may be previewed with no Etsy connection. Never imply an Etsy listing was created, edited, published or had media uploaded.
- Avoid client-side API direct writes, credentials or feature toggles that can invoke provider calls. No real Etsy OAuth, external fetch, or provider account action in this PR.

## Acceptance cases for future P2-3 implementation

1. Zero photos; ready primary plus other ready; ready non-primary but primary processing/failed; missing primary; duplicates; varied sort order; 21+ photos; empty/overlong alt text.
2. Canonical ERP primary/order remain unchanged after preview; eBay and Noctella Web media views are unaffected.
3. Preview calculates ranks deterministically independent of upload transport; output sanitizes alt text and does not leak protected local storage URLs.
4. Single/multi video display contract is feature gated and acknowledges 2026-10-21 rollout boundary; no accidental replacement of first video.
5. End-to-end test confirms no backend mutation, Etsy OAuth usage, provider write or publication.
6. If Phase 1 is not yet in `main`, design can stay read-only/docs and must not modify #371.

## Later integration design (not authorized)

A separate Draft PR may propose `(productPhotoId, shopId, listingId, providerImageId, desiredRank, observedRank, syncState, lastError, idempotency metadata)` mapping; prefer a deterministic reconciliation flow and compensating actions over blind retries, especially with `overwrite` and images added asynchronously. Require explicit approval before schema changes, scope expansion or real Etsy writes.

## Delivery sequence

- P2-3a: this documentation-only verified API feasibility note; no dependency on P2-1 branch.
- P2-3b: pure, read-only media-plan selector + unit tests; **wait** for Phase 1 integrated interfaces and owner-reviewed base/branch choice.
- P2-3c: provider media mapping and draft-only integration; later explicit authorization and capability checks.
- Production/media cutover: independently authorized; not covered here.
