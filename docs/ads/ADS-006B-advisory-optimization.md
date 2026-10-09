# ADS-006B — Advisory-only optimization engine

Uses ADS-006A provider-specific metrics evidence and its provenance warnings. Recommendations are about further investigation of data and provider reports, not executable bids/budgets or inferred marketplace conversions.

- Missing spend and traffic => COLLECT_MORE_EVIDENCE
- Inconsistent or invalid metrics => REVIEW_DATA_QUALITY
- Spend/traffic with no provider returns => REVIEW_SPEND_AND_TRAFFIC
- Provider-reported conversion evidence => REVIEW_PROVIDER_REPORTED_RETURN

Every response: `eligibleForAutomaticAction=false`, `budgetChangeEur=null`, `campaignPauseExecuted=false`, `spendAuthorized=false`.

No independent analytics collector, campaign modification, margin calculation, generated conversion data or production database changes. Future optimizer must wait for authorized platform accounts and provider-real spend reconciliation, account-level hard limits, confirmed conversion evidence and active stock/campaign stop controls.
