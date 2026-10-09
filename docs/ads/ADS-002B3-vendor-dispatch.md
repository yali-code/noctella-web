# ADS-002B.3 — Consent-Gated Vendor Dispatch Foundation

**Status**: standalone pure infrastructure only; deliberately not wired to storefront events and no advertising provider activated.

## Shipped
- Dispatches whitelisted `page_view`, `view_item` and `marketplace_outbound_click` events only to explicitly injected adapters when the current persisted consent allows their category.
- Rechecks consent every time (including withdrawal), defaults to deny on bad/unavailable storage, omits user-supplied extra event fields and isolates adapter errors.
- No Pixel, GA4, GTM, Pinterest tag, cookie, browser beacon, fetch, localStorage read or network operation is executed by the module itself. Storage-reading function and provider adapters are injected, with no default providers.
- Test coverage includes no consent, granular consent, withdrawal, invalid events, extra data, unavailable adapters and provider errors.

## Gate before enabling a real adapter
1. Complete legal and privacy review of actual consent UX, links, proof/version/retention, geographical scope, storage-blocked behavior and policy.
2. Verify root and third-party tags do not fire before consent in browser network tests. Consent withdrawal must stop subsequent events and safely address loaded scripts/cookies.
3. Configure actual vendor IDs through approved environment settings without hard-coding or exposing secret server tokens.
4. Apply provider-specific event naming, opt-in Google Consent Mode v2 behavior, and Meta/Pinterest CAPI deduplication after provider authorization.
5. No synthetic Purchase event for eBay/Etsy external clicks. A platform-confirmed order is required.
6. Review ad tracking under regional advertising and marketplace terms before paid campaign launch.

Do not merge or deploy this draft until CI is green and review requirements are satisfied. No modifications to production SQLite, Render services or background jobs.
