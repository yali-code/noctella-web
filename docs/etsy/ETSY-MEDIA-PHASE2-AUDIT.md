# Etsy Phase 2 — ERP media parity audit (read-only findings)

Date: 2026-10-13. Independent of Claude's Phase 1 implementation. No application code changes.

## Verified current implementation (main)
- Admin product photo page `apps/admin/src/app/products/[id]/photos/page.tsx` uploads selected files **sequentially** through the existing single-photo endpoint; it already supports primary photo selection, ordering, deletion, alt text and thumbnail display. The UI says JPEG/PNG/WebP, max 10 MB per file, normalized to WebP.
- API `apps/api/src/routes/products.ts` uses `multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })` for `POST /:id/photos`. This stores uploaded bytes in process memory before processing. A 10 MB upload is **not** an upper bound on peak image decode/transformation RAM.
- Product photo storage workflow `apps/api/src/services/productPhotoStorageWorkflow.ts` manages file promotion and thumbnail availability.
- Current API route supports photo upload, alt-text update, primary photo, reorder and deletion. No Etsy-specific video or Etsy media publishing functionality verified in this audit.
- Historical Etsy payload `apps/api/src/integrations/productPublishingFoundation.ts` includes images, but no Etsy-specific media order, thumbnail crop or video mapping.

## Seller-reported Etsy New Listing UI
- Up to 20 photos and 2 videos; reorder media; primary image and thumbnail crop.
- UI evidence is not proof all operations are available via Open API v3; verify before implementation.

## Workstream 2A — No duplicate photo system
- Reuse canonical ProductPhoto references, primary and sort order.
- Introduce Etsy media selection/order override only if a channel-specific selection is necessary; do not mutate shared media order by default.
- Enforce Etsy-specific media count and format validation at the Etsy draft readiness layer, not by limiting canonical product photos.
- Check API image count, accepted types, video constraints, media endpoints, OAuth scopes, crop API availability and image ordering behavior against current Etsy developer docs.

## Workstream 2B — Bounded-memory uploads
- Investigate and benchmark upload route `multer.memoryStorage()` and downstream image normalization (Sharp or equivalent) on a 512MiB instance.
- Determine whether disk-backed streaming/temp files can be introduced safely without changing upload endpoint behavior, authorization, photo locks, ordering, outbox promotion, backup, cleanup or error semantics.
- Test 10+ sequential photos, invalid formats, max file size, processing failure and retries; measure peak RSS/heap and temporary file cleanup.
- Do not assert upload causes historical OOM without matching runtime logs/metrics. Do not change production RAM plan or deploy without explicit approval.

## Workstream 2C — Videos
- Inspect existing media asset/reel infrastructure; keep product listing videos distinct from Instagram reel assets.
- Define video asset storage, status, duration/size/type constraints, safe upload, preview and deletion; only implement provider publishing when supported by Etsy API and authorized.

## Workstream 2D — Publish readiness and state
- Preserve cover and order; define provider media IDs, upload progress, partial failure, idempotency and reconciliation.
- Require explicit owner approval to publish; no Etsy Ads changes.
- Validate required photos and the product's canonical stock and SKU before provider writes.

## Coordination
Claude owns Phase 1 Etsy form/data changes. Do not edit `ProductForm.tsx`, product schemas, migrations or Phase 1 branch while Claude works.
Phase 2 implementation should be a separate Draft PR with tests, no merge/deploy, only after Phase 1 integration interfaces stabilize.

## Acceptance checklist
- Canonical photo ordering and primary preserved.
- Etsy draft media selection can be reviewed before publish.
- No regression to existing eBay/Noctella Web photo flows.
- Etsy video support capability-gated.
- Peak RSS documented under representative upload workload.
- No production writes or deployment.
