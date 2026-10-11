# ADS-007 — Ads Intelligence (read-only, advisory)

`GET /api/analytics/ads/intelligence/:provider/:campaignId` reads stored windows and analyses them. It requires `analytics.view` and sends `no-store`.

**Source.** It reads every stored window for one paid campaign from `analytics_metric_snapshots`, using only the `paid_<provider>` namespace. Each window must pass the canonical ADS-006C trust rules on its own (`buildPaidCampaignReadout`). Untrusted windows are counted, never used. Organic social metrics and other campaigns are never read.

**Metrics.** Spend per day, CPC, CPM and CTR, plus cost per provider-reported conversion. Each comes only from known, non-zero denominators. Missing inputs are reported as gaps, never filled with zero. All amounts are EUR.

**Trends.** The newest window is compared with the previous non-overlapping window, normalised per day. Overlapping windows are excluded from the series and counted.

**Anomalies.** Rules are deterministic, compare against the campaign's own median baseline, and need a minimum history and volume (`ADS_INTELLIGENCE_RULES`). Codes:

| Kind | Codes |
|---|---|
| Performance | `SPEND_SPIKE`, `CTR_DROP`, `CPC_SPIKE` |
| Data quality | `SPEND_WITHOUT_DELIVERY`, `DELIVERY_WITHOUT_SPEND`, `CLICKS_EXCEED_IMPRESSIONS` |

**Recommendations are advisory only.** Codes: `REVIEW_DATA_QUALITY`, `INVESTIGATE_SPEND_SPIKE`, `REVIEW_CREATIVE_AND_TARGETING`, `REVIEW_BID_AND_COMPETITION`, `COLLECT_MORE_EVIDENCE`, `CONTINUE_MONITORING`. The response always returns:
- `eligibleForAutomaticAction: false`
- `budgetChangeEur: null`
- `spendAuthorized: false`
- `marketplaceRoas: null`
- `marketplaceAttributionVerified: false`
- `organicMetricsIncluded: false`

No external AI call, provider call, write or scheduler is involved.

**Not proven yet.** Results depend on real collected windows, which need approved staging collection (see #335). Thresholds are conservative defaults and must be reviewed against real campaign history.

**Account identity.**
- Every window must carry exactly one verified stored ad-account ID. A window with a missing, malformed or inconsistent ID is excluded and counted as untrusted.
- If the trusted windows of one provider campaign come from more than one ad account, the history is **quarantined** with `status: ACCOUNT_CONFLICT`. The result then has no windows, no trend, no anomalies, and only a `REVIEW_DATA_QUALITY` recommendation, plus per-account window counts.
- A single-account history reports its `accountId`.
