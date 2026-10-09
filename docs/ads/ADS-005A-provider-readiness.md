# ADS-005A — Dedicated Paid Ads Provider Readiness

Existing Instagram publishing, Pinterest social analytics OAuth, and GA4 browser analytics must not be treated as authorized Meta Ads, Pinterest Ads or Google Ads accounts. This module provides a sanitized read-only server configuration assessment for all three advertising platforms.

## Dedicated server-only variables (all optional and absent by default)
NOCTELLA_META_AD_ACCOUNT_ID / NOCTELLA_META_AD_ACCESS_TOKEN
NOCTELLA_GOOGLE_ADS_CUSTOMER_ID / NOCTELLA_GOOGLE_ADS_DEVELOPER_TOKEN / NOCTELLA_GOOGLE_ADS_OAUTH_ACCESS_TOKEN
NOCTELLA_PINTEREST_AD_ACCOUNT_ID / NOCTELLA_PINTEREST_AD_ACCESS_TOKEN

No values are printed, transmitted, returned or persisted. Do not copy existing Instagram/Pinterest social tokens into these fields automatically. The module does not authenticate with platforms, start OAuth, fetch campaigns, create campaigns, or authorize spend. Credentials-present only means CONFIG_REVIEW_REQUIRED; never CONNECTED.

Operational verification still requires provider API authorization tests with scopes, billing, policy checks, token refresh/encryption strategy, legal review and owner confirmation.
