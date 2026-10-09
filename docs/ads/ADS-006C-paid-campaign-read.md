# ADS-006C — Existing Analytics Agent paid campaign read adapter

An authenticated, read-only paid-campaign reporting boundary over existing `analytics_runs` and `analytics_metric_snapshots`. **No second datastore** and no migrations. Current platform-specific paid collectors have NOT been connected: the normal and correct response is `NOT_COLLECTED` with null evidence, not a false zero-spend report.

## Reserved future verified-collector contract
- `scope_type=external_ad_campaign`, `scope_id=paid_<provider>:<campaignId>`
- `metric_namespace=paid_<provider>`, `source_type=external_platform`, completed analytics_run
- `source_reference=<provider>.ads.*` and metadata `paidAdsSource:true`, `provider`, `campaignId`, `currency:EUR`, `windowSemantics:fixed_range`, `window:{start,end}`
- Only five explicitly declared paid metrics are permitted: paid_spend_eur, paid_impressions, paid_clicks, paid_provider_conversions, paid_provider_conversion_value_eur.
- Provider-source observations (if eventually collected) retain their own fixed reporting window and exact run identity. Never aggregate mismatched windows or currencies and never treat organic analytics as paid observations.

## Read endpoint
GET `/api/analytics/ads/performance/:provider/:campaignId` with existing `analytics.view` authorization.

This read returns paid evidence plus non-executable ADS-006B optimization advice. No provider APIs, ads, live pixels, spend or database writes. It does not verify provider authenticity by itself: **only genuinely verified paid-provider collectors should ever be permitted to write the reserved source contract**.

Future operational work: provider-approved OAuth with granted scopes, billing and campaign account verification, collectors with idempotent writes to the existing Analytics Agent tables, campaign-attribution reconciliation against marketplace-confirmed orders, and controlled campaign stop/budget enforcement.
