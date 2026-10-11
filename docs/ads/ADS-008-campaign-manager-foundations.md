# ADS-008 — Campaign Manager foundations (non-executing)

This builds on ADS-004A/B/C (brief, budget guard, draft plan), ADS-005A (readiness) and ADS-005B (dry-run preflight). None of those are duplicated.

| Capability | Implementation |
|---|---|
| Campaign draft model | `buildCampaignDraft`: provider, product, objective, marketplace destination, creative, targeting hints, EUR budget, `status: DRAFT` |
| Targeting recommendations | Keyword hints from Marketing Tags (004A) plus a category hint. Geography and demographics are `null`; the owner must confirm them. No inferred audiences. |
| Proposed budget | Taken from the existing budget guard (004B). Errors: `BUDGET_NOT_PROPOSED`, `BUDGET_BLOCKED`, `BUDGET_EXCEEDS_HARD_LIMIT` |
| Creative selection | `selectCampaignCreativeMedia`: only `Ready`, Noctella-hosted ERP product photos above a minimum size, primary first, capped per provider. Every exclusion is listed with its reason. |
| Validation and capability checks | `validateCampaignDraft` against `ADS_PROVIDER_CAPABILITIES`. These are **planning defaults, unverified**; re-check them against provider docs before any execution design. A shortened headline or text is always reported. |
| Draft preview | `GET /api/analytics/ads/campaign-draft/:productId?provider=…&requestedDailyEur=…&hardDailyLimitEur=…&hardTotalLimitEur=…` requires `analytics.view`, sends `no-store` and uses a strict query. It does not write. |
| Explicit approval | `campaignDraftFingerprint` (SHA-256 of canonical content) and `evaluateCampaignDraftApproval`. Possible results: `STALE` after any edit, `EXPIRED` after 24 h, `INVALID`, `EXCEEDED_BY_DRAFT`, `DRAFT_INVALID`. Even the best result, `APPROVED_FOR_EXECUTION_REVIEW`, keeps `executionAuthorized: false`. |
| Audit trail | `buildCampaignDraftAuditEvent`: a sanitized event with ids, fingerprint and EUR caps, but no free text or secrets. |
| Provider execution | Disabled for every provider (`executionEnabled: false`). Preview, approval and audit never create, change, activate or fund a provider campaign. |

## Owner decision required: persistence

Recording approvals and audit events durably needs **new SQLite tables** (`ads_campaign_drafts`, `ads_campaign_draft_approvals`, `ads_campaign_audit_events`) plus approve/reject routes. Under the project rules, a schema change needs owner approval, so none is included here. Until then:
- the approval policy and audit builder are pure and fully tested;
- no approval can be recorded;
- `ownerApprovalRecorded` stays `false`.

## Test evidence

- `adsCampaignDrafts.test.ts`: selection, draft, validation, fingerprint, approval states, audit and execution disabled.
- `adsCampaignDraftsHttp.test.ts`: 401/403, strict query (an `approved=true` parameter is rejected with 400), and no POST/PUT/PATCH/DELETE route.

A full happy-path preview over a seeded ERP product is left to Phase 9 acceptance.
