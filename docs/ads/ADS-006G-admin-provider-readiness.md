# ADS-006G — Provider readiness inside existing Admin Marketing

Adds an explicit owner-facing review of Meta Ads, Google Ads and Pinterest Ads prerequisites under the **existing** Marketing page. Uses the authenticated, no-store `GET /api/analytics/ads/providers/readiness` endpoint previously introduced by ADS-005A.

- Checks only the **presence** of dedicated server-side paid Ads configurations; never sees or shows their values.
- Does not claim that account scopes, billing, ownership, OAuth or connections have been verified.
- Distinguishes organic Instagram/Pinterest accounts from Meta/Pinterest paid accounts.
- Has only a read-only status refresh. No credentials upload, connect, spend, publish, pause or budget action.
- No backend configuration, secrets, database, Render or production changes.

Owner creates approved ad accounts and app permissions later. Use verified staging connection tests to transition to operational readiness in a **separate reviewed feature**, not by changing the displayed labels to CONNECTED without proof.
