# W4 real-photo colour check — 1 November 2026

This record supersedes, for current status only, the W4 statement "real-photo colour check NOT DONE (open
follow-up at first real W4 use)" in `docs/release/SUPERSESSION_RECORD_20261022.md` §1. Earlier files are not
edited and remain the historical record. All times UTC unless marked.

## 1. First real W4 use (production)

- Environment: production API `noctella-production-api` (`srv-db34390m7kps73cv8l6g`), runtime
  `843cb46b8e5bb1faac98085fa7c0c3f020cc84b3`, fencing ON, preparation confinement required, maintenance OFF.
- Product: `NOC-000019` "Vintage Heuer Stopwatch with Box", product id `2c985a84-d9a9-459a-8f4a-102e237e85fd`. This
  is a real inventory item.
- AI-intake flow, Render request logs, 1 November 2026, admin session:

  | Time (UTC) | Request | Status |
  |---|---|---|
  | 19:57:07 | `POST /api/ai-product-intakes/` | 201 |
  | 19:59:21 | `POST /api/ai-product-intakes/:id/photos` | 201 |
  | 19:59:32 | `POST /api/ai-product-intakes/:id/generate` | 200 |
  | 19:59:54 | `POST /api/ai-product-intakes/:id/stock-acceptance` | 409 (validation; fields were then corrected with `PATCH /api/ai-product-intakes/:id/proposal/fields/:field` → 200) |
  | 20:00:18 | `POST /api/ai-product-intakes/:id/stock-acceptance` | 201 |
  | 20:00:21 | `POST /api/ai-product-intakes/:id/finalize-photos` | 201 |

  There were no error- or warn-level API logs between 19:51Z and about 20:02Z.
- Read-only database check (owner production Shell, 20:04:12Z):
  - product `draft`, stock 1;
  - photo `26e76448-69ed-406e-9355-674d27050172` `Ready`, primary;
  - `photo_operations` kind `ai_finalize` state `committed` (1);
  - no Pending/RetryPending/Processing outbox events;
  - 1 stock movement;
  - `photos:operations-report` exit 0;
  - `/var/data` used 73 → 74 MiB.

## 2. Owner colour check

- The owner compared the finalized product photo with the original and reported that the colours are the same
  and the photo is clear.
- Owner statement: 1 November 2026, 22:08 Europe/Istanbul, owner's project-management chat.

## 3. Scope and limits

- One real product and one photo, with a visual check by the owner.
- No Delta-E measurement, no calibrated display, and no wide-gamut or general colour-fidelity claim.
- The synthetic ICC evidence in `docs/engineering/evidence/w4-color/` remains the technical regression evidence.

## 4. New status

- **W4 ICC/colour: synthetic CI PASS + owner-accepted (synthetic scope) + real-photo owner colour check DONE (1
  November 2026). W4 colour item CLOSED.**
