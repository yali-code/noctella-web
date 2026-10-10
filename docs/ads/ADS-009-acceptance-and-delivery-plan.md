# ADS-009 — Acceptance matrix, dependency map and delivery plan (Phases 6–9)

State on 2026-10-10. This is engineering evidence only. **No phase is operationally complete.** Nothing has been merged, deployed or activated, and there has been no ad spend.

## Branch and dependency map

```
main (ab9d5f4)
├── #334 ADS-006E reader provenance ─────────────────────────────┐
├── #336 ADS-006F collectors ── #339 ADS-006I windows/conflicts ──┤
├── #337 ADS-006G readiness UI ── #341 ADS-006K UI tests ─────────┤
├── #338 ADS-006H reconciliation ── #340 ADS-006J evidence binding┤
├── #342 Phase 6 closeout docs                                    │
├── feat/ads-007-intelligence (Phase 7) ─────────────────────────┤
├── feat/ads-008-campaign-drafts (Phase 8) ──────────────────────┤
├── test/storefront-wishlist-flaky-remove (CI flake fix) ────────┤
└── test/ads-009-acceptance = local merge of all of the above + Phase 9 acceptance test
```

- **Merge order (owner decides):**
  1. Wishlist flake fix (independent).
  2. #334.
  3. #336 then #339.
  4. #337 then #341.
  5. #338 then #340.
  6. ADS-007, then ADS-008.
  7. ADS-009.
  8. #342.
- **Conflicts:** none. The full composition merges cleanly. ADS-007 and ADS-008 both touch `routes/analytics.ts` in separate places; I adjusted ADS-008's import to avoid a textual conflict.
- **Code dependencies:**
  - ADS-007 works against both the `main` reader and the hardened #334/#340 reader, because it reuses `buildPaidCampaignReadout` for each window.
  - ADS-008 depends only on `main` (ADS-004/005).
  - The ADS-009 acceptance test needs the whole stack.

## Integration checkpoint (local composition `test/ads-009-acceptance`)

| Check | Result |
|---|---|
| API ads/paid/analytics suites (32 files) | **222/222 PASS** |
| `adsPhase9Acceptance.test.ts` (cross-module) | **8/8 PASS** |
| API, Admin and storefront typecheck | PASS |
| Admin marketing tests and lint | PASS |
| Storefront Wishlist suite | 24/24 PASS (5 local repeats on the fix branch) |
| GitHub CI | Runs when the Draft PRs are opened (no write token here) |

## Phase 9 acceptance matrix

| Area | Code-level evidence | Operational state |
|---|---|---|
| Authentication / authorization | `paidAdsAdminHttp`, `adsIntelligenceHttp`, `adsCampaignDraftsHttp`: 401/403, strict input (400), no-store | Staging check BLOCKED: collectors not deployed |
| Provider readiness | `paidAdsReadiness`, `PaidProviderReadinessReview.test` (config ≠ verified ≠ spend) | Meta read verified by owner; Google and Pinterest BLOCKED |
| Read-only collector integrity | `paidAdsProviders`, `metaPaidEndToEndSqlite`, acceptance: GET/SELECT only, fixed hosts, identity, EUR, time zone | No reportable campaign: BLOCKED |
| Reporting provenance | Account-local windows (DST and fractional-hour tests), run/source provenance, stored account id | Live `timezone_name` not yet observed |
| Financial reconciliation evidence | `paidSpendReconciliation`, acceptance: bound to stored provider/account/campaign/window; UTC-day billing gives `SCOPE_MISMATCH` | No finalized billing source: BLOCKED |
| Campaign approval isolation | `adsCampaignDrafts`, acceptance: fingerprint binding; the best case is still `executionAuthorized: false`; analytics untouched | Approval persistence needs a schema decision |
| No-spend guarantees | Every output has `spendAuthorized: false`; no mutation routes; provider execution disabled | Holds by construction |
| Duplicates / retries | Replay is idempotent; restatement and same-end windows fail closed | — |
| Provider failures | 429, Meta 190/17, 403, 500 and malformed responses store nothing; classified kinds | — |
| Secret redaction | Token absent from errors, outputs and the full analytics DB dump | — |
| Migration safety | No ads/paid tables; paid data only in `analytics_*` with namespace `paid_meta` | No migration in Phases 6–8 |
| Rollback | `ADS-006-PHASE6-CLOSEOUT.md` (#342) | Owner-run |
| Admin UX | Readiness checklist, paid report section | Intelligence and draft preview have API only; no Admin UI yet |
| Cross-module integration | `adsPhase9Acceptance.test.ts`: mock Meta → collector → SQLite → report → intelligence → reconciliation | Mock-only, **not operational proof** |

## Findings recorded (not fixed here: on other workers' branches)

- `assertPaidCampaignQuery` (#336) checks window completeness with the real `Date.now()`, so it ignores the collector's injected `now`. This is minor: it only affects deterministic tests of future-dated fixtures, and the account-local check in #339 does use `now`.
- CI #456 failed on a docs-only commit because of a storefront Wishlist race: `ProductCard` sets its wishlist label in an effect. Fixed test-only on `test/storefront-wishlist-flaky-remove`.

## External authorization and provider checklist (owner)

1. Open Draft PRs for ADS-007, ADS-008, ADS-009 and the Wishlist fix so CI runs. Do not merge.
2. Approve a staging-only deploy of the integrated stack, then re-run `ads:meta:verify` (expect EUR, `ads_read` and `reportingTimeZone`).
3. A reportable Meta test or real campaign, and approval for a read-only staging collection with snapshot writes.
4. Google Ads: a dedicated account, developer token (Basic or higher) and OAuth credentials, verified read-only.
5. Pinterest Ads: a dedicated ad account and advertising scopes, separate from social analytics OAuth. Confirm the UTC reporting dates.
6. Finalized provider billing statements through an owner-approved channel.
7. A schema decision for persisting campaign drafts, approvals and audit events (ADS-008).
8. Marketplace attribution evidence (eBay/Etsy), only if attribution is to be claimed.
9. Any execution capability (campaign creation or budget changes) needs a separate design review and authorization. Out of scope here.

## Revised estimate (engineering only, based on repository findings)

| Item | Estimate |
|---|---|
| Code for Phases 6–9 | Foundations and acceptance tests are implemented. Remaining: Admin UI for Intelligence and draft preview (~1–2 days), approval/audit persistence after the schema decision (~1–2 days), CI review fixes (~0.5–1 day) |
| Engineering total | **~3–5 working days**, if review is prompt |
| Operational closure | Gated by items 2–8 above (accounts, campaigns, billing). Calendar time depends on provider approvals, e.g. the Google developer-token review, not on engineering. **The 7–12 day target is achievable for engineering, not for operational acceptance, unless the external items arrive in parallel.** |
