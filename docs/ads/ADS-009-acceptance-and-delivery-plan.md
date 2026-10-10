# ADS-009 — Acceptance matrix, dependency map and delivery plan (Phases 6–9)

Updated 2026-10-10. This is engineering evidence only. **No phase is operationally complete.** Nothing has been merged, deployed or activated, and there has been no ad spend. The staging steps are in `ADS-009-staging-acceptance-checklist.md`.

## Draft PR dependency map

```
main (ab9d5f4)
├── #343 Wishlist race fix (canonical) ── #350 (2 sibling assertions)
├── #334 ADS-006E reader provenance
├── #336 ADS-006F collectors ── #339 ADS-006I windows/conflicts ── #344 direct-store window guard
├── #337 ADS-006G readiness UI ── #341 ADS-006K UI tests
├── #338 ADS-006H reconciliation ── #340 ADS-006J evidence binding
├── #345 ADS-007 Intelligence (+ account-conflict quarantine) ── #348 Admin intelligence (+ stale-response guard)
├── #346 ADS-008 Campaign drafts ─┬─ #349 Admin draft preview (+ stale-response guard)
│                                 └─ #351 exact marketplace destination allowlist (other worker)
├── #342 Phase 6 closeout docs
└── #347 test/ads-009-acceptance: integration-only composition + Phase 9 acceptance
```

**Recommended merge order (owner decides; each PR reviewed on its own):**
1. #343, then #350.
2. #334.
3. #336, then #339, then #344.
4. #337, then #341.
5. #338, then #340.
6. #345, then #348.
7. #346, then #351, then #349.
8. #342.
9. **#347 is not merged as-is.** It exists to show that the whole stack composes and to run CI over it. After steps 1–8 land, open one small PR from `main` carrying only the Phase 9 files (`apps/api/tests/adsPhase9Acceptance.test.ts`, `docs/ads/ADS-009-*.md`) and close #347.

**Phase 9-specific review:** review only the non-merge commits of #347 (`git log --no-merges origin/main..test/ads-009-acceptance -- apps/api/tests/adsPhase9Acceptance.test.ts docs/ads/ADS-009-*`).

**Canonical Wishlist fix:** #343, plus a follow-up branch for the two sibling assertions with the same race. The earlier duplicate branch `test/storefront-wishlist-flaky-remove` is superseded; #347 reverts its merge. Delete it only with owner approval.

**Conflict hygiene:** the full composition merges with no conflicts.
- ADS-008 places its route import beside the draft-plan import.
- 007a renders inside `PaidCampaignPerformanceReview` rather than editing `page.tsx`, where #337 inserts at the same line.
- 008a renders under the page heading.

## Integration checkpoint (#347 local composition, all branches above)

| Check | Result |
|---|---|
| API ads/paid/analytics suites (32 files) | **228/228 PASS** |
| `adsPhase9Acceptance.test.ts` | **11/11 PASS** (ERP → media → draft, account conflict, lookalike destination) |
| Admin marketing tests (4 files, incl. deferred-response stale tests) | 17/17 PASS |
| API build and Admin `next build` (CI placeholder `NEXT_PUBLIC_API_BASE_URL`) | PASS |
| API, Admin and storefront typecheck | PASS |
| Admin marketing lint | PASS |
| Storefront Wishlist suite | 24/24 PASS |
| GitHub CI | Runs on #347 after push. #344 and the stacked follow-ups get CI coverage through #347, because their own base is not `main`. |

**#344 regression probe** (local, not committed, on #344's head; 54/54 together with the existing paid suites):
- On Sofia's 23-hour DST day, the window is exactly 22:00Z–21:00Z.
- 1 ms before the end, both the direct store and the collector reject the window, with 0 runs and 0 snapshots written.
- Exactly at the end, the window is accepted.
- An identical replay is idempotent; a restatement fails closed and leaves history unchanged.
- The reader period is exact.

## Phase 9 acceptance matrix

| Area | Code-level evidence | Operational state |
|---|---|---|
| Authentication / authorization | HTTP tests for performance, readiness, intelligence and campaign draft: 401/403/400, no-store, no mutation routes | Staging smoke test pending |
| Provider readiness | API test plus Admin test: configured ≠ verified ≠ spend | Meta read verified by owner; Google and Pinterest BLOCKED |
| Read-only collector integrity | Providers, end-to-end and acceptance: GET/SELECT only, fixed hosts, identity, EUR, time zone | No reportable campaign |
| Reporting provenance | Account-local windows (DST and fractional zones), run provenance, stored account id, #344 boundary guard | Live `timezone_name` not observed |
| Financial reconciliation | Bound to stored provider/account/campaign/window; UTC-day billing gives `SCOPE_MISMATCH` | No finalized billing |
| Approval isolation | Fingerprint binding; any edit makes the approval stale; the best case is still `executionAuthorized: false`; Admin shows "approval not recorded" separately from "execution disabled" | Persistence needs a schema decision |
| No-spend | `spendAuthorized: false` everywhere; provider execution disabled; no approve or launch UI | By construction |
| Duplicates / retries | Idempotent replay; restatement and same-end windows fail closed | — |
| Provider failures | 429, Meta 190/17, 403, 500 and malformed responses store nothing | — |
| Secret redaction | Token absent from errors, outputs and the analytics DB dump | — |
| Missing data / organic separation | Unknown is never zero; paid namespace only; no marketplace ROAS | — |
| Migration safety | No ads/paid tables; no schema change in Phases 6–9 | — |
| Cross-module chain | ERP → media → draft → simulated Meta → SQLite → report → intelligence → reconciliation | Mock-only, **not operational proof** |

## Security fixes in this round

| Defect | Fix | Evidence |
|---|---|---|
| ADS-007 could blend windows from different ad accounts into one campaign history | #345: each window needs exactly one verified stored account id; multi-account histories are quarantined as `ACCOUNT_CONFLICT` (no metrics, trend or recommendation) | SQLite regression tests; acceptance (two accounts collected → quarantine, cross-account reconciliation → `SCOPE_MISMATCH`) |
| Admin views could show a late response for an old campaign or provider, or a draft for old budgets | #348 (intelligence and existing performance view), #349 (draft preview): a request sequence drops stale responses and errors; any input change invalidates the view; drafts must match the requested caps | Deferred-response React tests, each verified failing without the fix |
| Lookalike marketplace destinations (#351, other worker) | Reviewed, not duplicated: exact eBay/Etsy domains, HTTPS only, no credentials or ports, marketplace must match the URL | Probe: uppercase, `:443`, query and `etsy.com/de` accepted; trailing dot, punycode/Cyrillic, `ftp:`, `user@`, `etsy.de`, `:444`, protocol-relative and `%2e` rejected. In the chain, the ERP funnel policy already excludes such listings (layer 1). |

## Remaining engineering items

| Item | Estimate |
|---|---|
| Owner-approved staging **write-collection command**, with its own acknowledgement and backup step (needed for operational checks, see the staging checklist §4) | ~0.5 day |
| Approval and audit persistence plus approve/reject API and UI, **after the owner's schema decision** | ~1–2 days |
| CI review fixes across 15 Draft PRs and the final small Phase 9 PR after the merges | ~0.5–1 day |
| `assertPaidCampaignQuery` (#336) uses the real `Date.now()` and ignores the injected `now` (test determinism only) | ~0.1 day, by the branch owner |

**Engineering total: about 2–3 working days.** Operational closure still depends on the external owner items (staging approval, a reportable campaign, Google and Pinterest accounts, billing statements, the schema decision).
