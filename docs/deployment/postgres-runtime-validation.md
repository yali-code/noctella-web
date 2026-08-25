# PostgreSQL Runtime Validation (Sprint 151)

## Purpose

This is a pre-production validation procedure for the RC.2 PostgreSQL code paths. It is not a production migration or cutover runbook. Production remains unauthorized.

## Disposable target requirement

Automated PostgreSQL tests may run only against a dedicated disposable database. `POSTGRES_TEST_DATABASE_URL` must use a PostgreSQL URL whose database name contains a separate `test` or `disposable` marker. Names containing `prod`, `production`, `stage`, or `staging`, and normal shared names such as `noctella` or `postgres`, are rejected before any connection or mutation.

The harness creates a random `sprint151_test_*` schema and drops only that schema during cleanup. The destructive setup/cleanup behavior is permitted only after the URL guard passes. Never set the test URL to Render staging, a shared Supabase project, or production.

Credentials and full URLs must not be printed or committed.

## Environment variables

- `POSTGRES_TEST_DATABASE_URL`: disposable test database used by `test:postgres`.
- `POSTGRES_PREFLIGHT_DATABASE_URL`: target for the read-only duplicate preflight.
- `DATABASE_POOL_TIMEOUT_MS`: optional connection timeout for the preflight.

The runtime tests set `DATABASE_DRIVER=postgres` internally after the disposable URL has been accepted. They do not enable `DATABASE_MIGRATION_EXECUTION_ENABLED` and do not use the disabled production migration path.

## CI execution

GitHub Actions provisions PostgreSQL 16 with a health check and a dedicated `noctella_sprint151_test` database, then runs:

```text
npm run test:postgres -w apps/api
```

PostgreSQL 16 is pinned because the repository does not specify an authoritative Supabase/PostgreSQL major version; version 16 is a conservative, currently supported server version. Supabase remains a separate controlled acceptance target.

## Local isolated execution

Provide a dedicated database whose name passes the guard, then run the same command:

```text
npm run test:postgres -w apps/api
```

If no approved disposable target exists, do not substitute a shared database. Leave local runtime validation pending CI.

## Migration execution

The test helper reads the existing PostgreSQL migration files in lexical filename order and applies them through `0021_sprint150_marketplace_sync_parity.sql` inside an explicit transaction. It then repeats the same migration chain to prove rerun behavior. The helper reuses migration files verbatim and is not a production migration executor.

The relevant final order is:

1. `0019_sprint149_product_lifecycle.sql`
2. `0020_sprint149_marketplace_publishing_parity.sql`
3. `0021_sprint150_marketplace_sync_parity.sql`

## Read-only marketplace duplicate preflight

Run against an explicitly selected PostgreSQL target:

```text
npm run db:marketplace-duplicate-preflight -w apps/api
```

The script opens `BEGIN TRANSACTION READ ONLY`, executes only grouped `SELECT` queries, and rolls back. It checks exactly:

- `marketplace_connections(channel, account_label)`
- `external_listings(channel, external_listing_id)`
- `marketplace_webhook_events(channel, external_event_id)`
- `marketplace_orders(channel, external_order_id)`

Zero duplicate groups exits successfully. Any duplicate group, connection failure, or query failure exits non-zero. Duplicate keys are emitted only as short SHA-256 fingerprints; credentials and URLs are not emitted.

## Mandatory STOP conditions

Stop before migration rollout when:

- any duplicate group exists;
- connectivity or a preflight query fails;
- migration execution fails;
- the target cannot be proven isolated;
- a same-named index may have an unexpected definition;
- backup and restore evidence is unavailable for a future non-disposable target.

Never delete, update, merge, or automatically deduplicate historical rows. Manual investigation and separate authorization are required.

## Controlled Supabase validation

After deterministic CI PostgreSQL validation is green, the same focused runtime scenarios should be executed against a dedicated disposable Supabase PostgreSQL database. This secondary step must use an isolated project/database and must not become a required CI secret or contact shared staging/production.

## Remaining debts

- Verification of existing same-named index definitions.
- An operator-approved production migration executor and rollback procedure.
- Backup/restore proof before any non-disposable migration.
- Dedicated Supabase-hosted runtime acceptance.
- `stockSync.ts` PostgreSQL parity, which remains explicitly deferred.
- Production deployment and cutover, which remain unauthorized.
