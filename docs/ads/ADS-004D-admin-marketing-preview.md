# ADS-004D — Existing Admin Marketing: read-only campaign preview

Replaces the existing `/marketing` placeholder using the application's existing authenticated `api.get` browser client. The screen accepts a validated ERP product ID and positive EUR amounts with two decimal places, then calls the authorized ADS-004C draft endpoint. It displays existing Marketing Tags hints, reviewed eBay/Etsy listing links, historical finance evidence, budget blockers and exclusion reasons.

## Safety
- No browser or server ad creation; no provider credentials, network trackers, advertising spend, new database tables, hidden approval or automatic publishing.
- Browser rejects invalid product identifiers and malformed amounts. Server independently validates query and requires `analytics.view`.
- Does not trust a response that claims provider-live verification or spend authorization; the marketing UI refuses to show such a response.
- Links carry `rel="noopener noreferrer"`; no PII, purchase attribution or synthetic conversion events.
- "Preview" is not approval: actual provider status/stock must be checked again before a future ad launch.
- Production availability and provider identity are not proven by this UI. No Render deployment is performed here.

## Deferred to future phase
Real AI-assisted copy requires proof-grounded generation and human review. Owner approval persistence and advertising-provider execution must be added only after verified provider accounts, legal consent review, live stock pause mechanism, and budget enforcement. Do not imply those are present from this screen.
