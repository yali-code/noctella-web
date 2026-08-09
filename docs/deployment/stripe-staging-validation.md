# Stripe Staging Validation Runbook

This runbook governs a separately authorized, post-merge Stripe test-mode staging validation. It is not evidence that staging is ready.

> **NO REAL STAGING PAYMENT MAY RUN UNTIL STAGING ISOLATION IS EXTERNALLY VERIFIED.**

The repository does not prove deployed database/storage isolation, backup-bucket or credential isolation, deployed environment values, or test-mode Stripe credentials. An operator must verify each externally before proceeding.

## Mandatory gate

- Confirm the correct Render staging services and the staging domains.
- Confirm the staging database and product-photo/storage services are isolated from production and expose no production inventory.
- Confirm the API uses a Stripe test-mode secret and the Dashboard is in test mode. Never record the secret.
- Confirm `https://api.staging.noctella.com/api/webhooks/stripe` subscribes only to `checkout.session.completed`; configure its signing secret on the API only.
- Confirm success and cancel URLs target the staging Storefront, API health is good, and the webhook is publicly reachable.
- Satisfy one database recovery condition: use a disposable isolated staging database; or, before any drill involving valuable/shared staging data, make a recent off-disk staging backup and verify its restore.

If any item is unverified, stop. Do not run a payment.

## Normal test-mode payment drill

Execute only after separate authorization. Use a synthetic published staging product. Record redacted pre-test stock, payment, order, stock-movement, and invoice-outbox state. Start Checkout from staging Storefront and complete it with an official Stripe test card. Verify the webhook receives 2xx, payment becomes `paid`, persisted Session and PaymentIntent IDs match the test-mode Dashboard, and exactly one order, inventory decrement, stock movement, and invoice-draft outbox item result. Confirm the success page resolves the resulting order. Retain redacted evidence only.

## Duplicate-event drill

In the test-mode Dashboard, redeliver the exact same provider event. Verify a successful duplicate/no-op response; the same `providerEventId` remains correlatable; there is no second order, decrement, stock movement, or invoice outbox item; and payment/order linkage is unchanged.

## Terminal-failure drills

**ONLY IN DISPOSABLE / VERIFIED ISOLATED STAGING.** Do not execute as part of this PR.

For both a price change after Checkout starts and stock becoming unavailable after external payment, verify `manual_refund_required`, no failed-fulfillment order, inventory mutation, or invoice outbox, and identify the Session, PaymentIntent, provider event, classification, and error code. The operator then follows the external test-mode refund procedure below.

## Manual refund procedure (test mode)

1. Identify the internal Noctella payment and confirm `manual_refund_required`.
2. Confirm amount and EUR currency, Checkout Session (`providerReference`), and PaymentIntent (`providerTransactionReference`).
3. Confirm `providerEventId`, result classification, and error code.
4. Locate the matching objects in Stripe Dashboard test mode and perform the required refund externally.
5. Capture only redacted evidence and leave the Noctella payment in `manual_refund_required`.

Sprint 128 provides no durable acknowledgement that an external manual refund occurred. Production activation remains blocked pending later reconciliation capability and approved refund architecture.

## Evidence and security

Never capture Stripe secret keys, webhook signing secrets, signature headers, raw webhook bodies, customer addresses, customer email unless separately approved and operationally essential, or full checkout snapshots. Prefer internal payment/status, amount/currency, Session, PaymentIntent, provider-event, classification/error, order and stock-movement identities, and redacted timestamps/results.

## Failure and incident handling

- Webhook pending: inspect test-mode Dashboard delivery, endpoint configuration, and signing-secret configuration. Do not manually create an order.
- Migration/deployment issue: stop payment testing, preserve the database, use the existing recovery process, and do not edit rows manually.
- `manual_refund_required`: do not mutate the database to retry fulfillment or create a manual order; follow the external refund procedure.
- Any production or shared-data exposure: stop immediately, do not continue, and report a blocker.

## Production activation checklist

Staging validation is not production activation. Production remains out of scope and blocked until there is a successful test-mode staging drill, durable manual-refund acknowledgement/reconciliation, an approved Stripe refund strategy, verified database and product-photo backup/recovery, isolated production database/storage, production environment review, refund accounting/CreditNote policy, security/rate-limit review, incident/refund procedures, and explicit production-readiness approval.

No isolation, credential, webhook, backup, payment, refund, or production-readiness condition is asserted complete by this document.
