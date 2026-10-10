# ADS-006 Phase 6 closeout: status, evidence, rollback

Tracking issue: #335. State as of 2026-10-10.

**Phase 6 is NOT operationally complete.** The code-level foundations are implemented and tested. The remaining acceptance criteria depend on provider accounts, real campaigns, billing evidence and owner authorization, so they are **BLOCKED**, not done.

Standing owner instruction: NO MERGE, NO PRODUCTION DEPLOY, NO ADS SPEND, NO CAMPAIGN CHANGES.

## Code branches (all Draft or unmerged; none deployed)

| Branch | Base | Content | Evidence |
|---|---|---|---|
| PR #334 `test/ads-006e-…` | main | SQLite paid evidence provenance hardening | CI #424 PASS |
| PR #336 `feat/ads-006f-…` | main | Read-only Meta / Google Ads / Pinterest Ads clients, opt-in collector, manual preview and `ads:meta:verify` | CI #445 PASS |
| PR #337 `feat/ads-006g-…` | main | Admin paid provider readiness checklist | CI #426 PASS |
| PR #338 `feat/ads-006h-…` | main | Fail-closed spend reconciliation policy | CI #431 PASS |
| Draft PR #339 `feat/ads-006i-paid-window-provenance` | #336 | Account-local reporting windows; restatement and window-collision fail-closed; Meta error-code classification; authenticated Admin HTTP test; DST/offset regression tests | Local: paid suites PASS; API typecheck PASS. CI #451 pending |
| Draft PR #340 `feat/ads-006j-reconciliation-evidence-binding` | #338 | Reconciliation bound to stored **account**, campaign and window; rejects missing/mismatched stored account identity | Local focused tests PASS; CI #454 pending |
| Draft PR #341 `test/ads-006k-admin-readiness-ui` | #337 | Readiness UI tests and malformed/config-mismatch response fail-closed checks | Local: 2/2 PASS; Admin typecheck and lint PASS. CI #453 pending |

Draft documentation PR #342 carries this file. PRs #339/#340/#341 were opened as stacked Drafts; bases were temporarily pointed at main **only to run existing main-only PR CI**, and will be restored once CI evidence is collected. None of these PRs is merged.\n\nA prior local integration check merged main + #334 + 006I (#336) + #337 + 006J (#338) with **no conflicts**. Results: 23 ads/paid/analytics test files, **143/143 PASS**; API and Admin typecheck PASS; Admin marketing lint PASS. This was a local, unpushed composition, not CI.

## Defects found and fixed in this review (reproduced first)

1. Meta and Google report **account-local** days, but windows were stored as UTC days. Provenance was off by the UTC offset, and exact-window reconciliation compared mislabelled periods. (006I)
2. The "window complete" check used UTC only. A still-open local day could be stored as complete. (006I)
3. A second window with the same end was recorded as a `completed` run with **zero persisted rows**, because the snapshot identity collided. (006I)
4. A restated provider value was silently ignored on replay, leaving stale spend. Now `PAID_PROVIDER_RESTATEMENT` fails closed and keeps history. (006I)
5. Meta reports an expired token as HTTP 400 code 190; it was classified as generic `rejected`. It is now `authentication`, and the provider message is still never surfaced. (006I)
6. Reconciliation accepted scope-less evidence, so a report for another campaign or window could reach `RECONCILED_FOR_REVIEW`. (006J) A follow-up review also closed the same gap for **account ID**: the reconciler now requires a matching independently stored numeric account ID; legacy account-less reports cannot reconcile.

## Acceptance criteria (#335)

| Criterion | State | Evidence or blocker |
|---|---|---|
| Paid account ownership and scopes, verified separately per provider | **Meta: partially verified. Google, Pinterest: BLOCKED** | Owner ran a staging check on Meta account `3095361257478763`: HTTP 200, EUR, `ads_read` OK, 0 rows. The account's `timezone_name` is not yet observed; re-run `ads:meta:verify` once 006I is staged. There are no Google Ads or Pinterest Ads accounts or tokens. |
| Vetted read-only collectors on documented endpoints, reusing the analytics tables | **Code complete (Draft)** | #336 + 006I. GET/SELECT-only. Strict account, campaign, currency and window provenance. No new warehouse. |
| Staging collection with test accounts; token handling, idempotency, audit | **BLOCKED** | No reportable campaign. Collection in staging requires owner approval and the PRs being deployed to staging. Idempotency, restatement and collision handling are covered in tests. |
| Reconcile actual spend against provider windows; unknown stays UNKNOWN | **Policy complete (Draft); operationally BLOCKED** | #338 + #340 (006J, stored account/campaign/window binding). No authenticated provider billing source or finalized statement exists. |
| Provider conversions kept separate from eBay/Etsy sales | **Code complete** | Collectors set provider conversions to `null` (not collected). The reader always returns `marketplaceConfirmedOrders: null`, `attributedMarketplaceRevenueEur: null`, `reportedRoas: null`, `marketplaceAttributionVerified: false`. **Attribution evidence: BLOCKED.** |
| Authenticated `analytics.view` Admin read on staging against real SQLite | **Code-tested; staging BLOCKED** | `paidAdsAdminHttp.test.ts` (006I) runs the real app over in-memory SQLite and checks 401, 403, 200, no mutation routes, no token echo and read-only behaviour. Staging runs main `ab9d5f4` without #336. |
| No automated bidding, spend, launch or pause | **Verified in code and tests** | No write endpoint or scheduler exists. `spendAuthorized`, `eligibleForAutomaticAction` and `campaignPauseExecuted` are always false. The HTTP test shows POST/PUT/PATCH/DELETE return 404. |
| Staging API and Admin include #332/#333 and pass smoke tests | **Reported done by owner** | Staging serves `ab9d5f4` (includes #332/#333) and health checks returned 200, per the owner's 2026-10-10 comment. |
| Rollback and next steps documented; no production deploy without approval | **This document** | See below. |

## Rollback

Phase 6 code adds **no schema, migration, route, job, cron or environment-variable changes**. I checked the diffs of #334, #336, #337, #338 and 006I/J/K.

- **Code:** don't merge the PRs. If one has been merged, `git revert` the merge commit and redeploy the previous Render deploy. The collectors run only through manual `tsx` scripts with an explicit acknowledgement.
- **Credentials (owner, in the provider UI and Render):**
  - Revoke the Meta system-user token in Business Settings.
  - Remove `NOCTELLA_META_AD_ACCESS_TOKEN` and `NOCTELLA_PAID_ADS_PREVIEW_ACK` from the staging environment.
  - Never copy these values into GitHub, logs or chat.
- **Data:** paid evidence exists only if someone ran the opt-in collector with write approval. It lives only in `analytics_runs` (`run_type LIKE 'paid_%_campaign_metrics'`) and `analytics_metric_snapshots` (`scope_type='external_ad_campaign' AND metric_namespace LIKE 'paid_%'`). Removing it is a database write: back up first, get explicit owner approval, and never touch production `/var/data/noctella.sqlite` otherwise. With no rows, the Admin report shows `NOT_COLLECTED`.

## Next steps (owner-authorized only)

1. **Draft PRs are now open**: #339 (006I, restore base #336 after CI), #340 (006J, restore base #338 after CI), #341 (006K, restore base #337 after CI), and documentation #342. Review GitHub CI and leave all Draft/unmerged.
2. On staging, after approval, deploy the integrated branch to **staging only** and re-run `ads:meta:verify`. Expect EUR, `ads_read` and a non-empty `reportingTimeZone`.
3. Create or identify a reportable test campaign. Run `ads:paid:preview` read-only. Run a staging collection only with explicit write approval.
4. Set up Google Ads (developer token and OAuth) and Pinterest Ads access as separate, dedicated paid credentials, then verify each read-only. Confirm Pinterest's UTC reporting dates against the live account.
5. Get finalized provider billing statements through an owner-approved channel before any reconciliation is claimed.
6. Get marketplace attribution evidence only with documented, deduplicated eBay/Etsy order linkage.

## GitHub connector write verification — 2026-10-10

- Issue #335 read and issue-comment write succeeded (comment ID 6099697769).
- Re-fetched PRs #334, #336, #337, #338, #339, #340, #341, #342: all OPEN, Draft, unmerged; #339 targets #336, #340 targets #338, #341 targets #337; other listed PRs target main.
- This documentation-only commit checks branch-scoped file write capability. It does **not** establish combined-stack integration, live provider readiness, staging smoke, billing reconciliation, attribution or owner activation approval. Phase 6 remains BLOCKED.
- No merge, deploy, environment modification, credential access, production data access or ad spend.
