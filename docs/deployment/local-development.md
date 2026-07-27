# Local Development: Stable Data and Photo Paths

Scope: the two local-dev environment values that control where `apps/api` reads and writes
persistent data — `DATABASE_URL` and `PRODUCT_PHOTO_DIR`. See `docs/deployment/render-staging.md`
for the equivalent staging configuration; this file only covers local dev.

## Use a stable absolute path for both

- `DATABASE_URL` should point at a stable absolute SQLite file path, e.g.
  `C:\Users\you\noctella-local-data\dev.sqlite`.
- `PRODUCT_PHOTO_DIR` should point at a stable absolute directory outside any generated build
  directory (never inside `apps/api/dist` or another path that gets wiped by a build), e.g.
  `C:\Users\you\noctella-local-data\product-photos`.

Both variables default to a path relative to the process's working directory when unset
(`./data/dev.sqlite` and `./uploads/product-photos` — see `.env.example`). A relative path is
resolved against wherever the API process happens to be started from, not against the repo root.
Starting the API from a different working directory (a different terminal, an IDE run
configuration, a background service wrapper) while relying on this fallback silently opens or
creates a **different, empty** SQLite database or photo directory at the new location — your real
local data isn't lost, it just becomes invisible until you start the API from the original
directory again. Setting both variables to a fixed absolute path removes this risk entirely.

## What Render staging already does

`render.yaml`'s API service sets `DATABASE_URL=/var/data/noctella.sqlite` and
`PRODUCT_PHOTO_DIR=/var/data/product-photos`, both absolute paths under the same mounted
persistent disk — the same principle as above, already applied in staging.

## Two standing constraints, independent of path stability

- **SQLite deployment must remain single-instance.** A single SQLite file cannot be safely shared
  across multiple concurrently-running API processes, locally or in staging.
- **No automated off-disk backup exists**, locally or in staging, for either the SQLite database
  or the product-photo directory. Treat both as reproducible from a fresh bootstrap, not as a
  system of record, until an automated backup is added.
