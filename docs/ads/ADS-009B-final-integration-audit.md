# ADS-009B — Final integration and security audit (Phases 6–9)

2026-10-10. Evidence types are labelled: **[SRC]** source inspection, **[LOCAL]** local tests, **[CI]** GitHub Actions. **No operational verification** has happened: there has been no live provider call, staging run or billing evidence.

## Findings

### A. Cross-account data isolation — PASS (fixed earlier in #345, re-verified)
- **Paths:**
  - **Intelligence:** quarantined as `ACCOUNT_CONFLICT`; a window with a missing or malformed stored `accountId` is untrusted.
  - **Report reader:** returns only the newest window together with its `accountId` (#340).
  - **Reconciliation:** requires the stored `accountId` to equal the billing account (#340).
  - **Collector:** the idempotency key includes the account; another account's window with the same end hits `PAID_WINDOW_END_CONFLICT` (#339).
- **Evidence:**
  - [LOCAL] SQLite regressions;
  - [LOCAL] acceptance: windows collected from two accounts are quarantined, and cross-account billing gives `SCOPE_MISMATCH`;
  - [CI] #347.
- **Residual risk:** windows written before account metadata existed become untrusted (fail-closed, as intended).

### B. Marketplace destination validation — PASS (#351, not duplicated)
- **Layers:**
  - **Layer 1, ERP funnel (ADS-002A):** HTTPS only; no credentials or port; host must equal a trusted eBay/Etsy root or be a subdomain of one.
  - **Layer 2, draft validation (#351):** exact bare or `www.` host, marketplace must match the URL.
- **Evidence:**
  - [LOCAL] probe on #351:
    - accepted: uppercase host, `:443`, query and fragment, `etsy.com/de`;
    - rejected: `ebay.de.attacker.com`, trailing dot, punycode and Cyrillic lookalikes, `ftp:`, `http:`, `user@`, `:444`/`:8443`, `etsy.de`, protocol-relative, `%2e`, cross-marketplace mismatch.
  - [LOCAL] acceptance: lookalike, non-HTTPS and non-default-port ERP listings yield **no draft** (layer 1).
- **Redirects:** not applicable. Nothing fetches the destination URL; provider transport uses `redirect: "error"`.
- **Note (not a defect):** layer 1 accepts eBay-owned subdomains such as `m.ebay.de`, which layer 2 then rejects as an invalid draft (fail-closed).

### C. Admin asynchronous response safety — DEFECTS FIXED
| ID | Severity | Reproduction | Root cause | Files | Fix | Coverage |
|---|---|---|---|---|---|---|
| C1 | Medium | A response for a previous campaign, provider or budget resolves after a newer request or input change and replaces the view | No request identity; inputs did not clear the view | `PaidCampaignIntelligenceReview.tsx` (#348), `PaidCampaignPerformanceReview.tsx` (#348), `CampaignDraftPreviewReview.tsx` (#349) | Request sequence; any input change invalidates; responses must match the requested provider and caps | Deferred-promise React tests, each verified failing without the fix |
| C2 | Medium (pre-existing on `main`, ADS-004D) | Show a plan, edit a budget: the old plan with the old financial assessment stays visible. An in-flight plan for old inputs also lands after the edit | Same as C1, in `page.tsx` `generate()` | `apps/admin/src/app/marketing/page.tsx` | Branch `fix/admin-ads-draft-plan-stale` (from `main`): same guard; plan must match the requested product and caps | `page.test.tsx`, 3 tests, all fail without the fix |
| C3 | Low (UX/accessibility) | The composed page had two buttons named "Preview campaign draft" | Name collision between ADS-004D and ADS-008A | `CampaignDraftPreviewReview.tsx` (#349) | Renamed to "Preview provider campaign draft" | Existing tests updated |

**Residual risk:** none known. All Admin views are GET-only and advisory.

### D. Time consistency — DEFECT FIXED (low)
- **Reproduction [LOCAL]:**
  - Query a window for *tomorrow* (wall clock) with an injected `now` three days later.
  - Result: `assertPaidCampaignQuery` throws "must be complete", while the collector and store checks (using `now`) would accept.
  - The same inputs pass or fail depending on the wall clock: future-dated fixtures are time bombs.
- **Root cause:** `assertPaidCampaignQuery` read `Date.now()`, but the collector, observation and #344 direct-store checks used the injected `now`.
- **Files:**
  - `paidCampaignCollectorContract.ts`;
  - `metaPaidCampaignClient.ts`, `googlePaidCampaignClient.ts`, `pinterestPaidCampaignClient.ts`;
  - `paidAdsCollection.ts`.
- **Fix:** branch `fix/ads-006-clock-consistency` (stacked on #344). One `now` is threaded through query validation, the clients (optional `fetchCampaign(…, now)`), the observation and store checks. The default stays the wall clock, so production behaviour is unchanged.
- **Coverage:** `paidAdsClockConsistency.test.ts`:
  - acceptance at the exact injected end, rejection 1 ms before it;
  - the wall-clock default;
  - west-of-UTC (Los Angeles), where only the account-local check rejects.
  - These tests fail without the fix.
- **Side effect:** one E2E assertion now accepts either rejection message. For zones east of UTC, the UTC-day check is the stricter one and fires first; the window is still refused.
- **Residual risk:** `ads:paid:preview` still uses the wall clock. That is correct for a manual tool.

### E. Read-only guarantees — PASS [SRC][LOCAL]
- **Provider transport:**
  - fixed hosts `graph.facebook.com`, `googleads.googleapis.com`, `api.pinterest.com`;
  - `redirect: "error"`;
  - Meta and Pinterest are GET only;
  - Google uses POST only to `googleAds:searchStream`, with two server-built `SELECT` statements from digit and date-validated input. There is no `mutate` endpoint.
- **Routes:** there are no non-GET `/api/analytics/ads/*` routes. HTTP tests show POST/PUT/PATCH/DELETE return 404 for performance, readiness, intelligence and campaign draft.
- **Admin marketing:** only `api.get`.
- **Intelligence and Drafts:** contain no writes, no `fetch` and no provider client.
- **Every output has:**
  - `spendAuthorized: false`;
  - `executionEnabled` / `executionAuthorized: false`;
  - `eligibleForAutomaticAction: false`.
- **Schema:** none of these branches adds a table [LOCAL acceptance].

## Step 3 regression flow (simulated) — [LOCAL] `adsPhase9Acceptance.test.ts`, 11/11

The flow under test: ERP product → eligible photos → draft (budget guard blocks an unsold original) → simulated Meta → SQLite → report → intelligence → reconciliation. It checks:
- EUR only;
- Sofia account-local windows;
- account identity and quarantine;
- idempotent replay;
- `PAID_PROVIDER_RESTATEMENT`;
- billing scope (account, campaign and window; UTC days give `SCOPE_MISMATCH`);
- unknown vs zero (`NOT_COLLECTED`, Unknown, no zero-fill);
- approval invalidated by headline, media or budget edits (`APPROVAL_STALE`);
- `marketplaceRoas: null`;
- no ads or paid tables.

## Engineering recommendation

**GO for engineering review** of the Draft stack in this order:
1. #343 → #350
2. #334
3. #336 → #339 → #344 → `fix/ads-006-clock-consistency`
4. #337 → #341
5. #338 → #340
6. #345 → #348
7. #346 → #351 → #349
8. `fix/admin-ads-draft-plan-stale`
9. #342 and #352 (docs)

Then add the Phase 9 files as one PR from `main`.

**NO-GO for operational acceptance:** there is no staging run, no live provider evidence, no billing statements and no schema decision. See `ADS-009-staging-acceptance-checklist.md` and #352.
