# Render Staging Deployment Runbook

Scope: the approved `v2.0.0-rc.1` Render staging environment defined in `render.yaml`, Frankfurt
region, four services (API, Admin, Storefront, background-job Cron). This is **RC staging
infrastructure, not the final production architecture** — see "Explicit non-goals and risks"
below before using this environment for anything beyond staging validation.

## Ordered deployment process

1. **Confirm `main` and CI are green.** Every push/PR to `main` runs `.github/workflows/ci.yml`
   (typecheck, test, build, lint across all workspaces). Do not proceed if the latest commit on
   `main` has a failing or pending CI run — Render's `autoDeployTrigger: checksPass` depends on
   this status.
2. **Create the Render Blueprint from `render.yaml`.** In the Render dashboard: New → Blueprint →
   point at this repository's `main` branch → Render parses `render.yaml` at the repo root.
3. **Confirm the four Render resources** were created as declared: `noctella-staging-api` (web),
   `noctella-staging-admin` (web), `noctella-staging-storefront` (web),
   `noctella-staging-background-jobs` (cron). Do not proceed if any resource is missing or
   misconfigured relative to `render.yaml`.
4. **Enter all `sync: false` / operator-provided secrets** in the Render dashboard for
   `noctella-staging-api`: `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`, and any
   marketplace OAuth values you intend to exercise (`EBAY_CLIENT_ID`, `EBAY_REDIRECT_URI`,
   `EBAY_WEBHOOK_SECRET`, `ETSY_CLIENT_ID`, `ETSY_REDIRECT_URI`, `ETSY_WEBHOOK_SECRET`). Leave
   any marketplace values you don't need for this staging pass blank — those features simply
   won't work, nothing else breaks.
   - **Webhook secrets (Sprint 77):** either set `EBAY_WEBHOOK_SECRET`/`ETSY_WEBHOOK_SECRET` to
     real staging-only values if you intend to exercise webhook delivery, or leave them unset.
     There is no known/default fallback secret — an unset, empty, or whitespace-only secret now
     makes signature verification for that channel fail closed (every webhook request for that
     channel is rejected) rather than silently accepting a known test value.
   - **`MOCK_PAYMENTS_ENABLED` (Sprint 76):** confirm this is `"true"` only on
     `noctella-staging-api` (already set in `render.yaml`). This flag must never be copied to a
     real production deployment before a real payment gateway is integrated.
5. **Configure DNS** for the three custom domains to point at their respective Render services,
   per Render's provided DNS instructions:
   - `api.staging.noctella.com` → `noctella-staging-api`
   - `admin.staging.noctella.com` → `noctella-staging-admin`
   - `shop.staging.noctella.com` → `noctella-staging-storefront`
6. **Confirm the API's persistent disk is mounted at `/var/data`** (`noctella-staging-data`,
   1 GB, declared under `noctella-staging-api` in `render.yaml`). Do not proceed to step 8 if the
   disk isn't attached — both the SQLite database and product photos live there, and neither is
   backed up anywhere else in this staging setup.
7. **Confirm the two disk-backed environment values are exactly**:
   - `DATABASE_URL=/var/data/noctella.sqlite`
   - `PRODUCT_PHOTO_DIR=/var/data/product-photos`

   Both are already set as non-secret values in `render.yaml`; this step is a manual sanity
   check before real data enters the system.
8. **Deploy the API first**, and wait for it to report a healthy deploy before touching Admin or
   Storefront.
9. **Verify `GET https://api.staging.noctella.com/health`** returns `{"status":"ok"}`. This is
   also Render's own `healthCheckPath` for this service — a green Render deploy already implies
   this passed, but confirm it manually once before proceeding.
10. **Deploy Admin and Storefront** (they can deploy in either order or in parallel once the API
    is healthy).
11. **Run the compiled bootstrap-admin command from the running API service's shell** (Render
    dashboard → `noctella-staging-api` → Shell):

    ```
    node apps/api/dist/scripts/bootstrapAdmin.js
    ```

    This reads `BOOTSTRAP_ADMIN_EMAIL`/`BOOTSTRAP_ADMIN_PASSWORD` from the environment (entered
    in step 4) and creates the first Owner admin account. It is a safe no-op if an admin user
    already exists — re-running it after the first successful run does nothing.
12. **Confirm the first Owner account was created** by logging into
    `https://admin.staging.noctella.com` with the bootstrap email/password.
13. **Remove or rotate `BOOTSTRAP_ADMIN_PASSWORD`** in the Render dashboard after the bootstrap
    account is confirmed working — it has no further purpose once the first Owner exists, and
    leaving a real password sitting in an env var is unnecessary exposure.
14. **Verify the hourly Cron execution.** In the Render dashboard, open
    `noctella-staging-background-jobs` and either wait for the next `0 * * * *` run or trigger a
    manual run, then confirm it completed successfully (exit code 0). It calls
    `POST /api/background-jobs/run` on the API over Render's private network
    (`API_HOSTPORT`/`SCHEDULER_AUTH_TOKEN`, both wired via `fromService` in `render.yaml` — never
    a public `onrender.com` hostname).
15. **Execute the complete staging smoke-test checklist** below.

## Staging smoke-test checklist

Run every step against the real staging domains — **not** `localhost` and **not** any
`onrender.com` fallback hostname, since that would not exercise the actual `COOKIE_DOMAIN`/CORS
configuration this environment is meant to validate.

- [ ] API health: `GET https://api.staging.noctella.com/health` → `200 {"status":"ok"}`
- [ ] Admin login: log in at `https://admin.staging.noctella.com/login`
- [ ] Authenticated reload / session persistence: reload an authenticated Admin page and confirm
      you remain logged in (not bounced back to `/login`)
- [ ] Admin server-side data fetch: load an Admin page that fetches data server-side (not just
      client-side) — this is the step most likely to silently fail if `COOKIE_DOMAIN` is wrong,
      since it proves the session cookie is being forwarded from `admin.staging.noctella.com`'s
      own server back to the API
- [ ] Dashboard ERP report: confirm the Admin Dashboard's ERP report loads real data
- [ ] Product creation: create a product in Admin
- [ ] Stock adjustment: adjust stock on that product
- [ ] Storefront catalog: load `https://shop.staging.noctella.com` and confirm published
      products appear
- [ ] Guest checkout: complete the full guest checkout path (cart → address → payment mock →
      order created)
- [ ] Make an Offer: submit a guest "Make an Offer" on an eligible product
- [ ] Read-only marketplace connections: load the Admin marketplace connections list (read-only —
      do not exercise a real OAuth connect/publish flow against live eBay/Etsy unless you
      intentionally configured staging-safe credentials in step 4)
- [ ] Background-job run: confirm the Cron service's most recent run succeeded (see step 14)
- [ ] Logout: log out of Admin and confirm a subsequent authenticated request returns 401
- [ ] Mock payment labeling (Sprint 76): the Admin Orders list and order detail page show the
      payment provider suffixed with `(mock)` for the order created in the guest-checkout step
- [ ] Restart persistence: create a temporary staging order and upload a temporary product photo,
      redeploy or restart `noctella-staging-api`, and confirm both the order and the photo are
      still present afterward
- [ ] Order cancellation restores inventory: cancel a temporary staging order through normal Admin
      behavior (no direct database edits) and confirm the product's stock quantity is restored
- [ ] Audit history intact: confirm no existing audit history was deleted by the steps above
- [ ] Do not use the HERMLE fixture for any of the above — use a temporary product/order created
      for this staging pass instead
- [ ] Stale-lock crash recovery is exercised only via the existing automated tests
      (`productPhotoOutboxStaleLockRecovery.test.ts`) — do not attempt to simulate a stale lock by
      manually killing or corrupting the live staging process/disk

## Webhook verification acceptance (Sprint 77, optional)

Only run this if you configured real staging-only webhook secrets in step 4. This confirms
signature verification fail-closed behavior without exercising real eBay/Etsy integrations.

- [ ] An invalid or unsigned request to `POST https://api.staging.noctella.com/api/webhooks/ebay`
      (or `/etsy`) is rejected
- [ ] With the corresponding `*_WEBHOOK_SECRET` left unset, any request to that channel's webhook
      endpoint is rejected the same way — verification fails closed
- [ ] Neither case creates a webhook-event row or a marketplace order
- [ ] Do not print or store real secret values, signatures, or request bodies in screenshots,
      logs, or committed files while running this check

## Explicit non-goals and risks

- **This staging setup uses SQLite and local product-photo storage on one persistent Render
  disk.** There is no replication, no automated off-disk backup, and no object storage.
- **The API must remain single-instance.** SQLite on a single mounted disk cannot be safely
  shared across multiple running API instances — do not scale `noctella-staging-api` beyond one
  instance under this configuration.
- **Disk-backed deploys can have brief downtime.** A new deploy that reattaches the persistent
  disk is not guaranteed to be zero-downtime; expect a short gap during API redeploys.
- **This is not the final production architecture.** PostgreSQL/Supabase and object storage
  remain explicitly deferred for this staging pass (see `.env.example`'s Postgres/Supabase
  section, all unused while `DATABASE_DRIVER=sqlite`).
- **Do not use this staging environment for irreplaceable production data.** Treat everything on
  the persistent disk as disposable and reproducible from a fresh bootstrap, not as a system of
  record.
- **`COOKIE_DOMAIN` must remain `.staging.noctella.com`.** Changing Admin or the API to a
  different subdomain without updating this value will silently break Admin's server-side data
  fetching (see the smoke-test step above) without breaking client-side-only interactions,
  producing a confusing partial failure.
- **Smoke testing must use the custom staging domains** (`api.staging.noctella.com`,
  `admin.staging.noctella.com`, `shop.staging.noctella.com`), never `localhost` or an unrelated
  `onrender.com` domain — those bypass exactly the CORS/cookie-domain configuration this
  environment exists to validate.
- **Verify the Render-generated `MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY`** actually satisfies
  `apps/api/src/services/credentialEncryption.ts`'s requirement (must decode to exactly 32
  bytes) before relying on marketplace OAuth credential storage in staging — Render's
  `generateValue: true` produces a random string, but its exact format was not verified against
  that decode check as part of this sprint.
