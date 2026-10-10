# ADS-006J — bind spend reconciliation to stored report provenance

Stacked on ADS-006H (PR #338). This is pure policy code plus tests. It has not been merged or deployed, and it reads no billing data.

## Defect

`reconcilePaidSpend` accepted an `AdsPerformanceEvidence` as the report. That object carries no campaign, account, window or source. The `SCOPE_MISMATCH` check only compared the billing statement against the caller's own `campaignId` and `reportWindow`. So spend evidence collected for a different campaign or period could reach `RECONCILED_FOR_REVIEW`, as long as the amounts happened to match.

## Fix

The report is now the stored paid readout produced by the ADS-006C reader (`buildPaidCampaignReadout`) from `analytics_metric_snapshots` and `analytics_runs`.

- `NOT_COLLECTED`, or no report at all, gives `MISSING_REPORT`. Unknown spend also gives `MISSING_REPORT`, never zero.
- `UNTRUSTED_EVIDENCE` gives `INVALID_REPORT`. So do contradictory metrics, which existing behaviour already rejected.
- The provider, **stored paid account ID**, campaign and window recorded with the source snapshots must equal the reconciled scope. Otherwise the result is `SCOPE_MISMATCH`. Caller-supplied `accountId` is not independent evidence.
- All other statuses are unchanged. A positive result is still advisory (`RECONCILED_FOR_REVIEW`) and never authorizes spending or budget changes.

## Known limitation

- The readout now exposes validated `accountId` from the snapshots when present. Legacy snapshots without a valid stored account ID remain readable, but reconciliation **fails closed** with `SCOPE_MISMATCH` until the source account is verifiable. No inferred account identity from campaign ID or caller input.
- With ADS-006I, report windows are account-local instants. Billing periods must be expressed the same way. A billing statement in UTC days gives `SCOPE_MISMATCH`, which is fail-closed and intended.

## Still blocked (external)

There is no authenticated provider billing source yet. Finalized billing statements need owner-approved provider billing access, and there are no reportable campaigns.
