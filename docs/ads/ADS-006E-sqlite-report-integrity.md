# ADS-006E — SQLite-backed paid evidence integrity validation

This narrow hardening PR exercises the actual ADS-006C paid-campaign read adapter against the repository's **real SQLite schema** from `ensureSchema`, using disposable `:memory:` databases and fake paid observations. No production database, migrations, live provider API, ad credentials or spending.

## Correction
A paid-scope metric snapshot with a missing, failed, foreign-type or source-mismatched analytics run must return `UNTRUSTED_EVIDENCE`, not appear as if no observations exist. Previously an INNER JOIN with a matching source filter could silently discard such rows. This PR uses a bounded left join, then validates the run status, type and reference in the read model. The exact campaign scope and paid namespace remain restricted.

## Integration checks
- No paid snapshots => `NOT_COLLECTED`, with neither fake spend nor artificial purchases.
- Five valid paid observations from a completed, matching Analytics Agent run => verified *provider observations*, not marketplace sale attribution.
- Orphan metric, failed run, internal source, different source reference => `UNTRUSTED_EVIDENCE`.
- Organic social media scope is ignored even if someone assigns it a paid-looking metric name.
- `total_changes()` confirms the read method does not modify the SQLite database.

This is a safety/test improvement **not** a real paid-provider collector, not a conversion attribution connector, and not a complete Etap 6 operational closure. Deploy to staging only through normal CI and Render auto-deploy; production stays untouched.
