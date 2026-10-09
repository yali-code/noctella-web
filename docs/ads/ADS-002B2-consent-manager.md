# ADS-002B.2 — Noctella Cookie Preferences UI

Status: draft for review; not a completed legal CMP certification.

## Behavior
- No existing user decision: show an accessible choice panel; analytics and marketing both default off.
- User can reject all optional categories, accept all, or save granular analytics/marketing choices.
- First-party localStorage decision version 1; stale, malformed or inaccessible storage is treated as undecided. The preferences control remains available to reopen and withdraw.
- No Pixel, CAPI, GA4, Pinterest tag, Google Consent Mode, vendor scripts or outbound telemetry are initialized. Simply accepting consent does **not** start any advertising technology in this PR.
- The privacy panel is mounted on storefront root layout, using no third-party packages or production configuration changes.
- No server logging, cookie identifier or persistent user identity is added.

## Follow-on release gates
1. Review actual regional CMP and GDPR/ePrivacy requirements, disclosure texts, privacy policy, retention, audit/proof-of-consent and vendor listing.
2. Implement vendor loader behind consent that defaults denied on first render. Test network calls and cookies before opt-in and after withdrawal.
3. Confirm whether any existing third-party analytics scripts live outside the main root layout (tag manager/CDN/provider).
4. Test accessibility, mobile overlays, browser storage blocked mode, preference changes in same tab and across tabs.
5. Add proper privacy information links and legal review before any ads go live.
6. Do not infer marketplace Purchase from outbound clicks.

Main/production/R2/SQLite/Social Manager and actual ad campaigns must not be modified by this draft.
