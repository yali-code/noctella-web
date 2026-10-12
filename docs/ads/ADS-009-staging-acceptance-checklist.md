# ADS-009 — Staging-only acceptance checklist (historical plan + current gate)

**Current checkpoint (2026-10-12):** This checklist originated as an unexecuted plan,
but E01/E02/E03, E05, E08, limited E12 and the **E07 independent R2 subgate**
have since gained staging evidence. See the authoritative current-status supplement
in [ADS-009A](./ADS-009A-staging-evidence-ledger.md) and
[issue #335](https://github.com/yali-code/noctella-web/issues/335).
Unmarked boxes in this historical procedure do **not** undo proven subgates.

**Next external blocker:** E06 has no owner-created paid Meta campaign with real
delivery, so do not run E07 `write` with a fabricated campaign ID or claim complete
acceptance. E09 also needs finalized billing. Production and spend remain
unauthorized. All paid-provider calls/data writes require their own explicit scope
and approval; deploying or passing R2 backup checks is not such approval.

## 0. Preconditions (owner)
- [ ] Explicit approval to deploy the integrated Draft stack to **staging only** (`noctella-staging-api` and Admin).
- [ ] Staging uses its **own** SQLite database on its **own Render service and disk**:
  - `render.yaml` gives staging `DATABASE_URL=/var/data/noctella.sqlite` on the disk `noctella-staging-data`.
  - The same *path* inside an isolated staging volume is expected and is not a problem in itself.
  - The invariant is identity: the staging API service and disk IDs must differ from production's.
  - Staging must never mount, attach, copy or read the production disk, the production SQLite file or production backup/photo buckets.
  - Attest the runtime targets with the sanitized operator procedure in `ADS-009C-staging-isolation-review.md` §4.
  - Take a staging-only backup before deploying. A restore rehearsal is a separately authorized step (§5 of that document).
- [ ] No schema migration is expected: Phases 6–9 add no tables, and paid evidence goes only to `analytics_runs` / `analytics_metric_snapshots`. Confirm that `ensureSchema` reports no new `ads*`/`paid*` tables.

## 1. Environment (names only; values are never written to GitHub, logs or chat)
| Variable | Purpose |
|---|---|
| `NOCTELLA_META_AD_ACCOUNT_ID`, `NOCTELLA_META_AD_ACCESS_TOKEN` | Dedicated Meta Ads system-user token with `ads_read` (not the organic Instagram token) |
| `NOCTELLA_GOOGLE_ADS_CUSTOMER_ID`, `NOCTELLA_GOOGLE_ADS_DEVELOPER_TOKEN`, `NOCTELLA_GOOGLE_ADS_OAUTH_ACCESS_TOKEN`, optional `NOCTELLA_GOOGLE_ADS_MANAGER_CUSTOMER_ID` | Google Ads read-only (blocked until the account and developer token exist) |
| `NOCTELLA_PINTEREST_AD_ACCOUNT_ID`, `NOCTELLA_PINTEREST_AD_ACCESS_TOKEN` | Pinterest Ads read-only, separate from social analytics OAuth (blocked) |
| `NOCTELLA_PAID_ADS_PREVIEW_ACK=I_AUTHORIZE_PAID_READ_ONLY` | Per-command read acknowledgement. Set it only for the duration of an approved check, then remove it. |

## 2. Meta account and time zone (read-only, owner-run)
- [ ] Run `npm run ads:meta:verify -w apps/api` inside staging. Expect `accountAccess: VERIFIED`, `currency: EUR`, a **non-empty `reportingTimeZone`**, and `reportRows ≥ 0`.
- [ ] Record the time zone in #335. Every paid window and billing period must use this zone's local days.
- [ ] Failure classes are printed without secrets: `authentication` usually means the 60-day token has expired; `permission` means `ads_read` or the account role is missing; `rate_limit` means retry later, manually.

## 3. Reporting-period availability
- [ ] A Meta campaign with real delivery exists, owner-created in the Meta UI and never by this system.
- [ ] Pick a **completed** window (all local days ended) of at most 31 days.
- [ ] Run `npm run ads:paid:preview -w apps/api` with provider, campaign and dates set via the `NOCTELLA_PAID_ADS_*` variables. This is read-only and writes nothing to the database. Check: identity matches, EUR, account-local window, and `NO_CAMPAIGN_REPORT` for empty data (not zero).

## 4. Read-only collector and staging write approval boundary (updated 2026-10-12)
- [x] **Engineering command exists (code + CI + staging deployment):** `node apps/api/dist/scripts/runMetaE07Staging.js` on staging API, introduced in [PR #364](https://github.com/yali-code/noctella-web/pull/364), with actual-runtime guard in #365. Default `preflight` and explicit `preview` do not write ERP SQLite; explicit `write` requires a separate per-invocation authorization. **Not an operational write PASS.**
- [x] **Independent R2 audit executed:** the separate, compiled `node apps/api/dist/scripts/checkMetaE07StagingBackup.js` command from #366 passed on the real staging shell without any campaign ID or write acknowledgements; see [record](https://github.com/yali-code/noctella-web/issues/335#issuecomment-6129294680). Audit age is a point-in-time observation, not a permanent fresh-backup guarantee.
- [ ] **E06 prerequisite:** wait for an actual owner-created, delivered Meta campaign and its completed account-local reporting interval. Never use synthetic/fake account or campaign IDs for live E07.
- [ ] **Actual E07 snapshot write requires separate operator approval:** verify real campaign read-only, re-verify a fresh dedicated staging backup, check staging service/disk identity, authorize only the narrow one-time scoped write. Verify before/after staging SQLite snapshot/run counts, then replay (expect `replayed: true` and unchanged rows). A genuine provider restatement must reject with `PAID_PROVIDER_RESTATEMENT`; same-end conflict must reject with `PAID_WINDOW_END_CONFLICT`. No production access or ad spend.

## 5. Admin authentication smoke test (staging)
- [ ] Without a session, `/api/analytics/ads/performance/meta/<id>`, `/ads/intelligence/...`, `/ads/providers/readiness` and `/ads/campaign-draft/...` all return 401. An Admin without `analytics.view` gets 403.
- [ ] Owner, Marketing page:
  - readiness shows "connection verified: NO" and "spending: DISABLED";
  - the paid report shows `NOT_COLLECTED` before collection;
  - Intelligence shows `NOT_COLLECTED`, or windows with Unknown where data is missing;
  - the draft preview shows "Draft approval: Not recorded" and "Execution authorization: Disabled", with no approve or launch button.
- [ ] POST/PUT/PATCH/DELETE on these paths return 404. Responses are `Cache-Control: no-store` and never contain token values.

## 6. Billing reconciliation (needs real evidence)
- [ ] A finalized Meta billing statement for the same account, campaign and **account-local** period, with ad spend only (tax and fees separated), obtained through an owner-approved channel.
- [ ] Expect `RECONCILED_FOR_REVIEW` only on an exact match within €0.01. Unsettled billing gives `UNSETTLED`. A period in UTC days gives `SCOPE_MISMATCH`. Never treat reporting-API spend as billing.

## 7. Provider error scenarios (to observe or confirm)
- [ ] Expired token: `authentication`, nothing stored.
- [ ] Throttling: `rate_limit`, no automatic retry loop.
- [ ] Wrong account or currency: rejected before metrics are requested.
- [ ] Malformed or paginated response: rejected.

## 8. Rollback
- Revert or skip the staging deploy. Restore the pre-deploy staging DB backup if paid rows must be removed.
- Revoke the provider token and remove the staging environment variables.
- See `ADS-006-PHASE6-CLOSEOUT.md` (#342).

## 9. Evidence required before declaring operational readiness
1. The verify output (sanitized), including `reportingTimeZone`.
2. A preview of a real completed window.
3. A stored collection plus replay evidence.
4. The Admin smoke test results.
5. A reconciliation against a finalized statement.
6. Google and Pinterest equivalents, or explicit owner de-scoping.
7. Attribution evidence only if attribution is claimed.

Mocked tests are **not** a substitute for any item here.
