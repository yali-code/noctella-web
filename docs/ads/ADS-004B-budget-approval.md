# ADS-004B — Budget/Profitability Advisory Guard

Read-only campaign budget proposal evaluation, reusing **existing Analytics Agent catalogue profitability** records and ADS-002C candidate eligibility. No new finance database, marketplace collector or ad account integration.

- EUR only. Fixed caller-provided daily and total hard caps; negative/non-finite/fractional-cent requests rejected.
- Incomplete cost basis or unverified profitability blocks the proposal instead of assuming profitable sales.
- Even a passing proposal returns **NEEDS_HUMAN_REVIEW**, `spendAuthorized: false`; this module has no spend API.
- Historical profit is evidence for a previous sale only, **not** a forecast that advertising this individual collectible will perform.
- Unreviewed proposed copy/audiences and supplier spend permissions remain prohibited.

## Further requirements before live campaign
Separate explicit owner sign-off, approved account IDs, provider budget API integration with idempotency, hard global caps, per-listing kill switch, reconciliation with actual spending and protection against sold-out stock are required. No production campaign may be launched on this function alone.
