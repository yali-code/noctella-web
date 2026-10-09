# ADS-002B — Privacy-first Ads Event Policy (foundation only)

**Status:** Development-only draft. This change does not load vendor tags, create cookies, write consent state, initialize Meta Pixel, call CAPI, create Google tags, alter storefront layout, or deploy anything.

## Goal
Build a later opt-in tracking and marketplace funnel for external acquisition into eBay and Etsy listings while respecting Noctella's production architecture.

## Architecture decisions
1. Existing storefront: `apps/storefront` Next.js 14.2.35. Existing root layout should not load marketing SDKs until CMP audit.
2. Explicit decision gate: missing/undecided = deny. Separate analytics consent for GA4 and marketing consent for Meta/Pinterest.
3. Allowed client events are `page_view`, `view_item`, `marketplace_outbound_click`; marketplace outbound is **not** a purchase.
4. Pure event projection whitelists product ID and destination only. No emails, IPs, buyer or order records, full URLs or query parameters sent by default.
5. No tracking and no vendor network requests occur in this PR. The caller MUST refuse to inject scripts before consent and immediately stop firing on withdrawal; script/cookie cleanup needs CMP-specific implementation and tests.
6. Google Consent Mode v2, Meta advanced matching/CAPI, Pinterest enhanced match/CAPI, GDPR regional requirements, controller relationships, retention and vendor contract settings are follow-on reviews. Consent Mode is not equivalent to legal consent.
7. Real `Purchase` attribution needs verified marketplace transaction evidence. No synthetic purchase or double counted offsite click.
8. Avoid changes to current `/api/public/products`, source-of-truth product inventory, SQLite, Analytics Agent collectors, Social Manager, Render or R2.

## Follow-up phases
- ADS-002B.2: review legally appropriate CMP UX, vendor category mapping, versioned proof of consent and withdrawal. Perform script-before-consent network audit.
- ADS-002B.3: implement controlled GA4, Meta and Pinterest vendor adapters behind that CMP gate; provider IDs from server configuration only; test network and event deduplication in staging.
- ADS-002C: landing page / marketplace buttons based on ADS-002A canonical stock/listing rules.
- ADS-002D: read-only Ads Manager report joins platform spend, permitted web events, and independently verified eBay/Etsy orders.

## Definition of done for this PR
- Pure policy and focused tests exist; no direct browser or provider effects.
- CI TypeScript/tests/lint/build passes.
- PR remains draft until CI confirms and architecture review is complete.
