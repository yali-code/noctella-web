# ADS-006H — paid provider spending reconciliation, advisory-only

A pure, testable comparison of **separately verified** Meta, Google Ads or Pinterest Ads provider report spend against that provider's **finalized** ad-only billing statement for the same account, campaign and exact UTC window.

An absent provider/billing record is `MISSING_REPORT`/`MISSING_BILLING`, not zero. Wrong currency, incomplete settlement, tax/fees included, mismatched window, untrusted billing source and material difference all fail closed. A positive result is `RECONCILED_FOR_REVIEW`, never automatic optimization permission.

This does **not** fetch invoices, claim an authenticated provider billing connector exists or claim conversions were independently verified on eBay/Etsy. Those depend on future platform account permissions. No API endpoint accepts user-created billing truth, no background job writes to production, no purchasing or automatic bid changes.

The owner must connect real paid accounts and independently approved reporting/billing sources before operational Phase 6 closure. This stays Draft / unmerged as requested.
