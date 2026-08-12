# Render Production Deployment Runbook — COD-Only Initial Launch

## PRODUCTION IS NOT AUTHORIZED MERELY BECAUSE SPRINT 135 MERGES.

Sprint 135 provides the code-level and configuration-artifact prerequisites for a controlled
production launch (`render.production.yaml`, `GET /ready`, the COD order-creation rate limiter,
the Admin Cash on Delivery settlement UI). None of that constitutes production authorization by
itself. Production go-live requires a **separate, explicit** decision after every item in this
runbook's ordered checklist is complete, independently confirmed, and the user has explicitly
authorized the cutover. Applying `render.production.yaml` in the Render dashboard does not deploy
anything until an operator manually triggers each service's first deploy (every service is
configured with `autoDeployTrigger: off` — see that file).

Scope: an initial **Cash on Delivery only** production launch. SQLite on a single persistent
disk, exactly one API instance, public Stripe checkout disabled. This is a separate, distinct set
of services from the existing staging Blueprint (`render.yaml`, `docs/deployment/render-staging.md`)
— neither environment modifies or depends on the other.

## Ordered pre-launch requirements

Every item below must be independently confirmed before requesting production authorization.
None of these are implemented or verified by this document — they are the checklist a human
operator works through.

1. **Separate production services provisioned** from `render.production.yaml` (New → Blueprint in
   the Render dashboard, pointed at this repository). Confirm all six declared resources exist:
   `noctella-production-api`, `noctella-production-admin`, `noctella-production-storefront`,
   `noctella-production-background-jobs`, `noctella-production-database-backup`,
   `noctella-production-product-photo-backup`.
2. **Manual deploy/promotion only confirmed** — every service in `render.production.yaml` has
   `autoDeployTrigger: off`. Verify this in the Render dashboard for each service; a commit to
   `main` must never silently deploy to production.
3. **Single API instance confirmed** — do not scale `noctella-production-api` beyond one instance
   under this SQLite-on-one-disk architecture (same constraint already documented for staging).
4. **Persistent SQLite disk confirmed** attached to `noctella-production-api` at `/var/data`.
5. **`DATABASE_URL` confirmed as an absolute path** on that disk: `/var/data/noctella.sqlite`.
   A relative path silently opens/creates a different, empty database — see `.env.example`.
6. **`PRODUCT_PHOTO_DIR` persistence confirmed**: `/var/data/product-photos`, on the same disk —
   otherwise every uploaded photo is lost on the next deploy/restart.
7. **`NODE_ENV=production`** set on all three web services (required for the Admin session
   cookie's `Secure` attribute — see `apps/api/src/auth/cookies.ts`).
8. **`ADMIN_APP_ORIGIN` configured** to the real production Admin origin.
9. **`STOREFRONT_APP_ORIGIN` configured** to the real production Storefront origin.
10. **`NEXT_PUBLIC_API_BASE_URL` configured correctly at build time** on both Admin and Storefront
    — this is inlined into the client bundle at build time; a wrong value requires a rebuild to fix,
    not a runtime restart.
11. **`STOREFRONT_SITE_URL` configured** to the real production Storefront origin (server-only,
    used for canonical/SEO metadata).
12. **`COOKIE_DOMAIN` configured only if Admin and API are deployed on different subdomains** of
    the same registrable production domain; leave unset for a single-host topology.
13. **`SCHEDULER_AUTH_TOKEN` configured consistently** between `noctella-production-api` and the
    three cron services (wired via `fromService` in `render.production.yaml` — confirm the actual
    values match, since this is what lets the hourly outbox sweep and the daily backups run).
14. **`STRIPE_PUBLIC_CHECKOUT_ENABLED` confirmed unset (or explicitly `"false"`)** — this is the
    COD-only launch gate (Sprint 134). Confirm via `GET /ready`'s `stripePublicCheckoutDisabled`
    check (step 22 below), not just by reading the dashboard.
15. **`MOCK_PAYMENTS_ENABLED` confirmed unset or `"false"`** — `render.production.yaml` already
    sets this explicitly to `"false"`; confirm it was not overridden in the dashboard. A real
    production launch must never accept a mock "always succeeds" payment.
16. **Bootstrap Admin exists** — run `node apps/api/dist/scripts/bootstrapAdmin.js` from the
    running API service's shell (reads `BOOTSTRAP_ADMIN_EMAIL`/`BOOTSTRAP_ADMIN_PASSWORD`; safe
    no-op if an admin already exists). Confirm login at the real Admin domain, then remove/rotate
    `BOOTSTRAP_ADMIN_PASSWORD` in the dashboard.
17. **Company profile configured** in Admin — required for invoice draft creation.
18. **Catalog/category/product/inventory data ready** — at least the initial launch catalog is
    created, published, priced, and has real stock quantities.
19. **At least one active, correctly-scoped shipping method configured** in Admin
    (`/settings/shipping`, Sprint 134) for the real launch destinations/catalog. This is launch-
    critical: with zero `shipping_methods` rows ever created, checkout silently uses legacy free
    shipping (see `docs/architecture/ARCHITECTURE_LEDGER.md`'s Sprint 134/135 entries) — `GET
    /ready` (step 21) is the automated proof this is satisfied, but the actual country/profile
    suitability for the real launch catalog remains an operator judgment call, not something
    `/ready` exhaustively infers.
20. **Database backup credentials configured** (`DATABASE_BACKUP_S3_*` on
    `noctella-production-api`) and **the daily backup cron confirmed to have run successfully at
    least once** (`noctella-production-database-backup`, 03:00 UTC — trigger a manual run from the
    Render dashboard rather than waiting a full day, if needed).
21. **Product-photo backup verified** if product photos are launch-critical (same pattern as
    step 20, `noctella-production-product-photo-backup`, 04:30 UTC).
22. **`GET https://<production-api-domain>/ready` returns `200 {"status":"ready", ...}`**
    immediately before traffic cutover. A `503` means at least one launch-critical condition is
    not yet satisfied — the response body's `checks` object identifies which (booleans only, no
    environment values or shipping configuration are exposed).
23. **One manual database backup taken immediately before cutover** (trigger
    `noctella-production-database-backup` manually one final time, independent of its schedule),
    as a point-in-time safety net separate from the daily schedule.

## Go-live smoke checklist

Execute this only after every item above is confirmed and the user has explicitly authorized the
cutover. Run every step against the real production domains, never `localhost` or an unrelated
`onrender.com` fallback hostname.

- [ ] `GET /health` → `200 {"status":"ok"}`
- [ ] `GET /ready` → `200 {"status":"ready", ...}`
- [ ] Storefront loads
- [ ] Public catalog returns only Published inventory
- [ ] Product title follows `wooProductName ?? title`
- [ ] Product price follows `wooListingPriceEur ?? priceEur`
- [ ] Real shipping methods appear for the chosen production destination/cart
- [ ] Displayed shipping amount matches the persisted `Order.shippingAmount` after checkout
- [ ] COD checkout succeeds
- [ ] Inventory decrements exactly once
- [ ] The same `orderDraftId` replayed does not create a second Order
- [ ] The Order appears in Admin (`/orders/[id]`) with the correct shipping snapshot
- [ ] Picking works
- [ ] Packing works
- [ ] Shipment creation/operation works
- [ ] Admin Cash on Delivery settlement UI is visible for the Pending COD order and works
      (Sprint 135, `/orders/[id]`)
- [ ] The correct collected total settles successfully; a mismatched amount is rejected
- [ ] A Draft SalesInvoice appears for the settled order
- [ ] `POST /api/payments/initialize {"provider":"stripe",...}` fails closed (`400`)
- [ ] An unauthenticated request to an Admin API route returns `401`
- [ ] Admin logout invalidates the session
- [ ] Verify backup state one more time immediately before opening traffic

This checklist is deliberately **not executed by this Discovery/Implementation task** — there is
no production deployment, DNS change, or live environment mutation performed by Sprint 135 itself.

## Explicit non-goals and risks

- **This deployment uses SQLite and local product-photo storage on one persistent Render disk.**
  Off-disk backup capabilities (Sprint 124/125) are not operational until an operator configures
  and verifies both external destinations (step 20/21 above) — do not treat local-disk data as a
  system of record before that verification.
- **The API must remain single-instance.** SQLite on a single mounted disk cannot be safely shared
  across multiple running API instances.
- **Disk-backed deploys can have brief downtime.** A new deploy that reattaches the persistent disk
  is not guaranteed to be zero-downtime.
- **Real Stripe checkout, PostgreSQL/Supabase, and horizontal scaling are explicitly out of scope**
  for this initial COD-only launch.
- **This runbook does not replace explicit human authorization.** Every checklist item above being
  green is a precondition for requesting authorization, not a substitute for it.
