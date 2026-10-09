# ADS-006D — Paid campaign performance in existing Admin Marketing

Adds a paid campaign report section to the existing authenticated `/marketing` screen, using the **existing** `api.get` client and the ADS-006C authorized GET endpoint. No second Admin surface, no new datastore, no provider browser SDK.

The UI requires a provider and numeric paid campaign ID. It explicitly distinguishes NOT_COLLECTED (no trusted paid provider observations) from UNTRUSTED_EVIDENCE and REPORT_AVAILABLE. Unknown values remain "Unknown"; provider-reported ROAS is labeled and is never characterized as marketplace-confirmed revenue. No action buttons for ad publication, pause, spend, attribution modification or account connection.

Development is code-only. It depends on the separate backend PR #332 for the reporting route. No credentials, production database or Render settings are changed. Live customer privacy and provider integration gates remain outstanding.
