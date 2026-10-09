# ADS-006A — Analytics Agent paid evidence projection

This is a pure read model that **reuses existing analytics_metric_snapshots** and the External Collector model once real paid-provider collectors are connected; it does not create a competing warehouse or second social analytics agent.

All fields explicitly distinguish paid Meta, Google Ads or Pinterest Ads metrics from existing organic social analytics. Provider-reported conversions and values are *claims from the ad provider*, not independently confirmed purchases on eBay/Etsy. `attributedMarketplaceRevenueEur` remains null. Outbound traffic never creates Purchase events.

Unknown expenses, counts and revenue remain null, never zero-filled. The only ROAS that can be calculated is provider-reported ROAS when positive spend and explicitly reported conversion value/count exist; it must remain labeled reported, not verified marketplace profitability.

No DB migrations, ad platform calls, automatic tuning, campaign spend or production changes are introduced. Future Phase 6 steps must build authorized provider collectors under the Analytics Agent, link account/campaign IDs to provenance, and implement independent paid spend reconciliation before any budget optimizer.
