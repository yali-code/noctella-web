# Etsy Phase 1 + Phase 2 isolated integration acceptance

## Provenance and scope

Starting SHA: `f9a61bf5a79e2cf182c04b5434c61bbe32fcfb32` (#477, `release/etsy-phase1-production-baseline`). Historical ancestor: `1994f50cd042f9c1a6121d2970ac8907caea8b3e`. This candidate is a descendant of that exact release baseline, not a merge of current main.

Phase 2 sources:

- #388, selector: `c19cc4206f5038a686c57f0b9ea7a281d60828d1`.
- #479, reusable component: `f95e8aff58d59c5c594ca98d3d957c4c0edb8430`.
- #480, Photos/Edit integration and media note: `fb5e6ce75ac4078c366aed5a5ffe3ae81c72f74a`.

Only the nine requested Phase 2 files were ported. The historical Photos/Edit pages, their tests, ProductDetail.photos and asset resolver matched the pre-Phase-2 sources, so no production-code adaptation was required. The selector and preview component are unchanged. Extra changes are compatibility tests, this note, and the exact candidate branch push trigger. One existing Phase 1 test now splits LF/CRLF SQL lines equally; its strict 23-column and nullable/additive assertions are unchanged. No dependency upgrade or new migration is included.

## Combined behavior

Phase 1 ProductForm, listing fields, validation, persistence, EUR pricing, stock and optimistic version protection remain unchanged. The read-only media preview on Photos and Edit uses canonical photos only and never establishes full Etsy publication readiness. It preserves Ready-only eligibility, explicit primary selection, duplicate/multiple-primary warnings, safe URL/thumbnail fallback, deterministic ranks 1–20, overflow and Unicode alt-text warnings. Reload uses the existing photo-operation lock and hides stale positive eligibility during pending/failed reads. Phase 1 Ads preferences remain preferences only; no activation or automatic provider action is added.

## Evidence and reproduction

Focused Windows commands use npm.cmd:

- `npm.cmd run test -w apps/admin -- src/components/EtsyListingFormFields.test.tsx src/lib/etsyMediaPlan.test.ts src/components/EtsyMediaPreview.test.tsx "src/app/products/[id]/photos/page.test.tsx" "src/app/products/[id]/edit/page.test.tsx"`
- `npm.cmd run test -w apps/api -- tests/etsyPhase1MediaIntegration.test.ts tests/etsyListingFormParity.test.ts tests/marketplacePublishing.test.ts tests/publishing.test.ts tests/unifiedPublishSprint141.test.ts`

The new SQLite tests exercise persisted Phase 1 fields -> canonical product detail -> Phase 2 selector, incomplete drafts with eligible media, no automatic GPSR/Ads/publishing, EUR/base-price and eBay preservation, optional Etsy quantity versus canonical stock, no new stock movements and stale-save rejection. Existing Phase 1 tests additionally cover all 23 nullable fields, legacy SQLite rows, structural validation and publication gates. New Edit tests cover persisted Etsy fields with preview, incomplete draft saves and version-conflict preservation.

The disposable PostgreSQL test constructs a pre-Phase-1 schema through 0038, inserts a synthetic legacy row, applies the existing additive 0039 twice, verifies 23 nullable/no-default columns and preserved data/stock, then reads canonical photos into the unchanged selector. It uses the existing guarded test URL and unique schema harness. No real customer database is read or changed.

Full candidate acceptance uses the existing CI pipeline: all workspace tests, types, builds and lint, plus real disposable PostgreSQL integration tests. Only the exact integration branch is added to push triggers; main and the original Phase 1 branch triggers and every job step remain unchanged. Final SHA, run ID, actual counts, independent-review findings and Windows limitations are recorded in the Draft PR. Source #480's earlier CI is not acceptance for this combined candidate.

## Release safety and rollback considerations

No backend, shared contract, ProductForm, schema or migration change is introduced by the integration. Phase 1's existing 23 nullable fields and 0039 remain the entire Etsy schema dependency. No Photo 0040/0041, W11/0042, ownership fencing, Ads activation, infrastructure port or intervening main history is imported.

This is an offline Draft candidate, not a production release. No merge, deploy, live database migration/restore, provider call/write, Render setting or feature activation is performed. If a later owner-authorized UI release must be rolled back, the prior Phase 1 application is the baseline; this port introduces no database or photo-data rollback requirement. Do not automatically drop Phase 1 columns, undo 0039, clean photo storage or run a restore.

Remaining gates: independent review of the exact candidate, exact-head CI acceptance and explicit owner release review/approval. Known Windows fixture capacity (ENOSPC), worker and setup-hook timing failures must be reported separately, never hidden by changing timeouts or assertions. No production rollout is authorized by CI or this document.

Code acceptance, readiness for owner release review and production deployment are separate statuses. Official engineering progress remains **4/12**. Photo F2 remains **HIGH/FAIL**, #472 owner-deferred, W11/0042 **BLOCKED**. No Stage 5 acceptance is implied.
