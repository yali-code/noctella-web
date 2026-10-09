# ADS-002B.4 — Consent withdrawal and blocked-storage hardening

## Scope
Improve the existing storefront `AdsConsentManager`; do not add a second consent system, tracking provider, background job, database schema or vendor script.

## Findings from code inspection
- Consent is stored in first-party `localStorage` via `apps/storefront/src/lib/adsConsentStorage.ts`.
- Pure `adsConsentDispatcher.ts` re-reads the stored decision before dispatch. No actual GA4, Meta or Pinterest adapter is registered.
- The existing consent UI did not react to cross-tab `storage` events.
- When storage was blocked, UI could incorrectly appear to accept consent while the event dispatcher would remain denied.

## Changes
1. Listen for same-origin cross-tab storage updates, including storage clearing and malformed or versioned-out decisions. Set toggles to the latest decision, or open the preference panel with both optional categories off if unknown.
2. On blocked writes, keep the panel open and show a clear error that optional tracking remains off; do not claim consent persisted.
3. Add focused browser tests for cross-tab withdrawal, deletion and storage failure.

## Privacy and launch gates still outstanding
- This is NOT a certified CMP or a legal/privacy review. Provide explicit privacy and vendor disclosures, consent policy versioning and jurisdictional guidance before activating third-party scripts.
- Audit actual staging browser network traffic for CDN-injected tags or other marketing requests, both before consent and after revocation. Repository search alone cannot prove absence of tags on deployment.
- Actual Meta Pixel/GA4/Pinterest scripts and server-side CAPI remain disabled/unimplemented.
- Third-party cookie deletion and script shutdown after withdrawal must be addressed before provider activation, not assumed from this client-only change.
- Do not infer marketplace Purchase from outbound clicks.

This PR is limited to the frontend consent UI and browser unit tests; do not touch SQLite, Render, API, product inventory or analytics data.
