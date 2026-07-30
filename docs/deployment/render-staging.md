# Render Staging Deployment Runbook

Scope: the approved Render staging environment defined in `render.yaml`, Frankfurt region, four
services (API, Admin, Storefront, background-job Cron). This is **RC staging infrastructure, not
the final production architecture** — see "Explicit non-goals and risks" below before using this
environment for anything beyond staging validation. `render.yaml` deploys whatever is on `main`
(it is not pinned to a specific release tag), so this runbook applies across release candidates;
see `docs/releases/` for the capabilities and known limitations of a specific candidate.

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

## v2.1.0-rc.2 Isolated Accounting Acceptance

This section exercises the accounting/invoice/refund/reversal behavior added since `v2.1.0-rc.1`
(Sprint 79 through PR #155 — see `docs/releases/v2.1.0-rc.2.md`). It is deliberately **separate**
from the general smoke-test checklist above and must run in an **isolated** environment.

### Isolation requirement (mandatory)

Use one of the following — never the environment described in the rest of this runbook as-is:

- **A. A disposable, dedicated staging service** with its own Render service and its own disk
  (e.g. `noctella-rc2-acceptance-api`), created and destroyed specifically for this acceptance
  pass; or
- **B. A separate `DATABASE_URL` SQLite path and a separate `PRODUCT_PHOTO_DIR`** on the existing
  staging disk (e.g. `/var/data/rc2-acceptance.sqlite` and `/var/data/rc2-acceptance-photos/`),
  never the paths declared in `render.yaml` (`/var/data/noctella.sqlite`,
  `/var/data/product-photos`).

### Explicitly forbidden during this acceptance pass

- Using the HERMLE product or any existing real/historical inventory record
- Altering any real or historical production-like record in any way
- Direct SQL edits of any kind, at any point, for any reason
- Manually deleting audit records (finance entries, refund events, invoice events, stock
  movements) to "clean up" a mistake — see the cleanup policy below instead
- Overwriting the normal company profile in a shared (non-isolated) environment
- Reusing the normal staging database (`/var/data/noctella.sqlite`) or the normal product-photo
  root (`/var/data/product-photos`) without the explicit isolation described above

### Synthetic data naming

Every synthetic record created for this acceptance (supplier name, product SKU/title, customer
name/email, company profile legal name) must use the obvious prefix `RC2-ACC-` so it can never be
mistaken for real data in any list, report, or export.

### Acceptance checklist

Each phase lists its precondition, the action to take, the expected result, the evidence to
capture, and the safety constraint that applies.

1. **Startup and migrations**
   - Precondition: isolated environment (A or B above) provisioned
   - Action: start/deploy the API against the isolated database path
   - Expected: startup completes, `ensureSchema` runs with no error
   - Evidence: startup log excerpt
   - Safety: never point this startup at the normal staging or production database path

2. **Health endpoint**
   - Precondition: API started
   - Action: `GET /health` on the isolated API
   - Expected: `200 {"status":"ok"}`
   - Evidence: response body
   - Safety: none beyond using the isolated API's own URL

3. **Admin login**
   - Precondition: isolated API healthy; an isolated Admin instance or Admin pointed at the
     isolated API via its own `NEXT_PUBLIC_API_BASE_URL`
   - Action: log in as the bootstrap/isolated admin account
   - Expected: session established
   - Evidence: screenshot
   - Safety: never use real staging or production admin credentials for this pass

4. **Synthetic company profile**
   - Precondition: logged in
   - Action: create a company profile named `RC2-ACC- Test Company`, `StandardVAT` tax treatment,
     synthetic VAT number, EUR, `defaultPricesIncludeVat: true`
   - Expected: profile saved, issue-readiness fields populated
   - Evidence: profile detail screenshot
   - Safety: never edit the normal/shared company profile for this

5. **Synthetic supplier**
   - Precondition: isolated environment
   - Action: create supplier `RC2-ACC- Acceptance Supplier`
   - Expected: supplier created
   - Evidence: supplier detail screenshot
   - Safety: `RC2-ACC-` prefix mandatory

6. **Purchase, allocation, receipt, and landed cost**
   - Precondition: synthetic supplier and a synthetic product (create as part of this step, SKU
     `RC2-ACC-000001`) exist
   - Action: create purchase (item 25 + buyer premium 5 + shipping 10 + packaging 2 = 42 EUR
     landed cost), allocate, receive
   - Expected: allocation and receipt succeed
   - Evidence: purchase/landed-cost summary screenshot
   - Safety: `purchaseCost` must be left unset (null) at product creation, not `0`, so the landed
     cost allocation actually writes it (see the known Sprint 80 pitfall)

7. **Unique product with stock 1, cost 42 EUR, price 120 EUR**
   - Precondition: purchase received
   - Action: verify product state
   - Expected: `stockQuantity: 1`, `purchaseCost: 42`, `priceEur: 120`
   - Evidence: product detail screenshot
   - Safety: none beyond the naming prefix

8. **Photo upload**
   - Precondition: product exists
   - Action: upload a product photo
   - Expected: photo created, `processingStatus: Processing`
   - Evidence: photo list screenshot
   - Safety: use only synthetic/placeholder image content

9. **Scheduler / outbox promotion**
   - Precondition: photo Processing
   - Action: wait for or trigger the isolated environment's scheduler
   - Expected: photo promotes to `Ready`
   - Evidence: photo status screenshot
   - Safety: trigger only the isolated API's own background-jobs endpoint, never the shared
     staging scheduler

10. **Storefront publication and visibility**
    - Precondition: photo Ready
    - Action: publish the product; load it on an isolated or pointed-at-isolated-API Storefront
    - Expected: product visible in the catalog
    - Evidence: Storefront screenshot
    - Safety: none beyond isolation

11. **Approved mock-payment staging flow**
    - Precondition: `MOCK_PAYMENTS_ENABLED=true` on the isolated API only
    - Action: confirm the mock-payment gate is active for this isolated instance
    - Expected: mock payment usable, clearly labeled `(mock)`
    - Evidence: settings/order screenshot showing the `(mock)` label
    - Safety: this flag must never be set on any real production deployment

12. **Paid internal order**
    - Precondition: product published, mock-payment gate confirmed
    - Action: create a paid internal order for the synthetic product (120 EUR)
    - Expected: order Paid, stock decremented to 0
    - Evidence: order detail screenshot
    - Safety: `RC2-ACC-` prefix on any free-text order reference

13. **Automatic SalesInvoice Draft creation**
    - Precondition: order Paid
    - Action: wait for/trigger the scheduler
    - Expected: exactly one Draft SalesInvoice for the order
    - Evidence: invoice list screenshot
    - Safety: none beyond isolation

14. **Invoice readiness**
    - Precondition: Draft invoice exists
    - Action: check issue-readiness
    - Expected: ready (company profile, VAT number, customer/billing fields all satisfied)
    - Evidence: readiness screenshot
    - Safety: none

15. **Invoice issue**
    - Precondition: readiness confirmed
    - Action: issue the invoice
    - Expected: status Issued
    - Evidence: invoice detail screenshot
    - Safety: issued invoices are immutable by design — do not attempt to edit after this step

16. **100 EUR base / 20 EUR VAT / 120 EUR total**
    - Precondition: invoice issued
    - Action: read the invoice figures
    - Expected: taxable base 100, VAT 20, total 120
    - Evidence: invoice figures screenshot
    - Safety: none

17. **Sale completion**
    - Precondition: invoice issued
    - Action: complete the sale
    - Expected: completion succeeds
    - Evidence: completion confirmation screenshot
    - Safety: none

18. **120 gross / 20 VAT / 100 net / 42 cost / 58 profit**
    - Precondition: sale completed
    - Action: read persisted sale financials
    - Expected: gross revenue 120, VAT 20, net revenue 100, item cost 42, profit 58
    - Evidence: financials screenshot
    - Safety: none

19. **Return lifecycle**
    - Precondition: sale completed
    - Action: request → authorize → receive → inspect → approve → complete a full-quantity return
    - Expected: return Completed
    - Evidence: return detail screenshot
    - Safety: none

20. **Stock disposition return_to_stock**
    - Precondition: return inspection step
    - Action: set disposition to `ReturnToStock` on inspection
    - Expected: disposition recorded
    - Evidence: inspection screenshot
    - Safety: this is the only disposition that restores sellable stock — confirm it was actually
      selected, not left at a default

21. **Successful full refund**
    - Precondition: return completed
    - Action: create a full refund (120 EUR)
    - Expected: refund Succeeded
    - Evidence: refund detail screenshot
    - Safety: none beyond isolation

22. **submittedAt and succeededAt populated**
    - Precondition: refund Succeeded
    - Action: inspect refund timestamps
    - Expected: both `submittedAt` and `succeededAt` populated and equal
    - Evidence: refund detail screenshot showing both fields
    - Safety: none

23. **Exactly one SuccessfulRefund finance entry**
    - Precondition: refund Succeeded
    - Action: inspect finance entries for the refund
    - Expected: exactly one `SuccessfulRefund` entry, referencing the correct refund and order
    - Evidence: finance-entry list screenshot
    - Safety: none

24. **Full sale reversal**
    - Precondition: return completed and refund succeeded (full amount)
    - Action: run the sale reversal
    - Expected: reversal created exactly once
    - Evidence: reversal detail screenshot
    - Safety: reversal is a terminal, correct action here — do not attempt to undo it

25. **Stock restored to 1**
    - Precondition: reversal complete
    - Action: re-check product stock
    - Expected: `stockQuantity: 1`, status Published
    - Evidence: product detail screenshot
    - Safety: none

26. **Effective financials reduced to zero**
    - Precondition: reversal complete
    - Action: read adjusted financials and the global finance summary
    - Expected: effective gross revenue/VAT/net revenue/item cost/profit all 0
    - Evidence: finance summary screenshot
    - Safety: none

27. **Immutable original sale snapshot**
    - Precondition: reversal complete
    - Action: re-read the original `sale_financials` record
    - Expected: unchanged from step 18 (120/20/100/42/58), preserved for audit
    - Evidence: comparison screenshot
    - Safety: never attempt to edit or delete this record

28. **Immutable issued invoice**
    - Precondition: reversal complete
    - Action: re-read the issued invoice
    - Expected: unchanged from step 16
    - Evidence: comparison screenshot
    - Safety: never attempt to edit or delete this record

29. **Exactly one of each expected record**
    - Precondition: all prior steps complete
    - Action: count sale, invoice, refund, reversal, and stock-movement rows for this order
    - Expected: exactly one of each expected type — one SalesInvoice, one completed-sale
      financial record, one refund, one reversal, one `sale_out` (-1) and one `return_in` (+1)
      stock movement
    - Evidence: counts screenshot or report export
    - Safety: none

30. **API restart persistence**
    - Precondition: all prior steps complete
    - Action: restart the isolated API
    - Expected: all of the above remains identical after restart
    - Evidence: before/after comparison
    - Safety: restart only the isolated instance, never the shared staging API

31. **Scheduler rerun idempotency**
    - Precondition: restart complete
    - Action: trigger the isolated scheduler again
    - Expected: no duplicate invoice, no duplicate finance entry, no state change
    - Evidence: before/after row counts
    - Safety: none

32. **Explicit evidence capture**
    - Precondition: all steps complete
    - Action: compile all screenshots/exports from steps 1–31 into a single acceptance record
    - Expected: a complete, reviewable acceptance trail exists
    - Evidence: the compiled record itself
    - Safety: never include real secret values in captured evidence

33. **Environment disposal or explicit retention decision**
    - Precondition: acceptance evidence compiled
    - Action: decide and record whether to destroy or retain the isolated environment (see
      cleanup policy below)
    - Expected: an explicit, documented decision — never left ambiguous
    - Evidence: the decision itself, recorded alongside the acceptance evidence
    - Safety: see cleanup policy below

### Cleanup policy

Issued invoices, completed sales, refunds, reversals, and finance entries **cannot be safely
deleted through Admin** — do not attempt it and do not assume it is possible.

- **Prefer destroying the entire isolated service/database/photo root** (option A or B above) once
  acceptance evidence has been captured and compiled.
- **Alternatively, retain the whole isolated environment** as historical acceptance evidence,
  clearly labeled as an acceptance artifact, not as staging or production data.
- **Never** perform direct SQL cleanup, at any point, for any reason.
- **Never** partially delete audit records (finance entries, refund events, invoice events, stock
  movements) — either the whole isolated environment is destroyed, or the whole record set is
  retained.
- **Never** copy any synthetic acceptance record into the normal staging or production database.

### Background-job stale-lock recovery

Do not intentionally crash a live staging or acceptance API to test stale-lock recovery. Destructive
crash-recovery behavior is already covered by existing automated tests
(`productPhotoOutboxStaleLockRecovery.test.ts` and related). For this acceptance pass, manually
verify only the **normal** case: a scheduler dispatch
that finds pending work processes it correctly (steps 9 and 31 above), and a repeat dispatch is
idempotent (step 31).

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
