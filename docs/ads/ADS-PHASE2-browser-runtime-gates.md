# ADS Phase 2 — Safe Browser Runtime / Remaining Activation Gates

The existing consent UI, storage schema and privacy-first dispatcher are reused. This PR adds a browser runtime interface which **defaults to zero active vendors**, tests explicit opt-in gating and withdrawal after repeated events, and enforces a provider-agnostic event whitelist. Nothing transmits a browser event until a separately reviewed adapter is injected; there are no pixels, loaders, CDN scripts, network requests, provider IDs or cookies in this PR.

## Phase 2 cannot be claimed operationally complete until
- Owner supplies and verifies GA4 measurement ID, Meta Pixel ID and Pinterest Tag ID as appropriate; permissions and advertising account ownership must be checked.
- Legal/privacy review of opt-in wording, retention, applicable regional rules, policy pages, withdrawal behavior and provider-specific consent settings is completed.
- Real browser staging network audits demonstrate zero nonessential requests/cookies before consent and safe revocation behavior. A repository search is insufficient.
- Provider-specific script loading after consent and SDK teardown/cookie cleanup on withdrawal are independently implemented and tested; persistent third-party cookies need special care.
- Conversion model never treats outbound marketplace clicks as purchases. Real sales reconciliation requires marketplace-confirmed orders and deduplication.

This delivers a tested, dormant integration contract, **not** working GA4/Meta/Pinterest tracking. It does not modify ERP data, staging/production, ad spend or Analytics Agent.
