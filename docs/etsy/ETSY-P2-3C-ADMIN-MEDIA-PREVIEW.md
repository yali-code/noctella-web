# Etsy P2-3C — Read-only Admin media preview

Tracks #391. Exact parent #388: `c19cc4206f5038a686c57f0b9ea7a281d60828d1`.

## Operator behavior

Etsy Media Preview appears on Product Photos and Product Edit. It uses canonical `ProductDetail.photos`, never legacy `images`. The unchanged `buildEtsyMediaPlan` selector supplies Ready-only candidates, primary-first ranks 1–20, exclusions, overflow and Unicode alt-text warnings. Validated URLs use the existing Admin asset resolver; absent thumbnails fall back to the safe full image. Storage keys and internal processing metadata are not rendered. Duplicate identities suppress candidate cards.

**Read only — not published or synced to Etsy.** Media eligibility does not prove listing-field or publication readiness. No automatic repair, upload, reorder, delete, or provider action is performed by the preview.

Photos reflects the existing reload after successful mutations and batch-upload completion. Failed single-photo operations retain the last read. The read-only Reload product photos button fetches canonical state without retrying writes or discarding alt drafts. Pending/failed reads hide stale preview eligibility. Edit shows the last product-read snapshot, excluding unsaved form edits; existing save/version-conflict/publish callbacks are unchanged.

## Acceptance

Focused tests cover frozen source compatibility, empty/Processing/Failed photos, primary ambiguity, duplicate identity rejection, missing/unsafe URLs, thumbnail fallback, deterministic ordering, 20/21/50 images, 500/501 Unicode code points, missing alt text, loading/errors, canonical-only reads, primary/alt-save refresh, failed operations followed by reload, failed-upload reload, no additional provider/mutation calls and no publishing-ready claim. Existing photo-management and edit/save/conflict/publish regressions remain intact.

Commands (repository root, Windows):

- `npm.cmd run test -w apps/admin -- src/lib/etsyMediaPlan.test.ts src/components/EtsyMediaPreview.test.tsx "src/app/products/[id]/photos/page.test.tsx" "src/app/products/[id]/edit/page.test.tsx"`
- `npm.cmd run test -w apps/admin`
- `npm.cmd run test -w apps/api`
- `npm.cmd run typecheck -w apps/admin`
- `npm.cmd run lint -w apps/admin`
- `npm.cmd run build -w apps/admin`

Existing CI retains every job/step and main trigger; only the exact integration branch is added to push triggers. It runs workspace tests, types, builds, lint and real disposable PostgreSQL tests. Final acceptance requires the final SHA's run. Consult the Draft PR for actual outcomes and limitations; local runs do not establish PostgreSQL or Linux acceptance.

## Independent release streams

PR A contains component/tests; PR B targets A and adds page integration, tests, this note and the CI trigger. Neither incorporates #371 or historical-release #477. Those Phase 1 branches change ProductForm/listing fields, untouched here. A later combined release needs compatibility review; this preview cannot replace Phase 1 publication validation.

No backend/schema/migration, photo storage/processing, stock, Ads, secrets or production configuration changes. No live provider calls, deploy or merge. Official progress stays **4/12**. Photo Stage 5 F2 **HIGH/FAIL**, #472 owner-deferred, W11/0042 **BLOCKED**; no Stage 5 acceptance implied.
