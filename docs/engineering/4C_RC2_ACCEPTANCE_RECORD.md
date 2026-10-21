# 4C authorized W8 canonical deletion: RC2 acceptance record (#424)

Status: **RC2 acceptance PASS (owner-executed). Production NOT RUN.** This record contains no production proposal;
see `docs/release/4C_PRODUCTION_RELEASE_PROPOSAL.md`.

## Candidate and evidence sources

| Item | Value | Source |
| --- | --- | --- |
| Runtime candidate | `43b9bc3af4be8ed89be35c95d59c26435485573e`, branch `feat/photo-4c-authorized-w8-deletion-20261021`, Draft PR #495 (base `integrate/photo-program-offline-20261021` = #494 head `35bd482`) | git |
| Scoped CI | run `39622178082`, workflow `photo-4c-acceptance.yml`, event `pull_request`, head `43b9bc3`, conclusion **success** | read-only GitHub API metadata (job logs not retrieved) |
| RC2 deploy | `dep-dbcdbqe1egvs73a9v6k0`, service `srv-d9ms1orncjis7390nk5g`, commit `43b9bc3`, status `live` | read-only Render metadata |
| RC2 configuration and results below | SQLite, fencing ON, Landlock confinement verified, preflight no FAIL; all runtime results | **owner-provided**; the agent did not execute or retrieve them |

## Code under acceptance (summary)

- `photoCanonicalDeletion.ts`: with fencing ON, W8 deletes a photo's two canonical names only under the
  `photo_operations` row lock. It requires:
  - a committed operation and intent;
  - both recorded copies;
  - no reference to the photo or its keys;
  - each name being the exact recorded copy inode with the sealed bytes.

  Otherwise it retains every file with a dead-lettered code. PostgreSQL retains
  (`PHOTO_DELETE_REFERENCES_UNSERIALIZED`).
- `productPhotoStorageWorkflow.ts` / `productPhotoOutboxDispatcher.ts`: fenced W8 routes through the deleter. It refuses
  without one. Fencing-OFF behavior is unchanged.
- `app.ts`, `outbox.ts`, `outboxRepository.ts`: scheduler-authenticated photo-only and exact-event dispatch. `claimById`
  uses the batch claim's predicate plus `id` and never releases stale locks.
- Independent non-authoring agent reviews of each delta: PASS / PASS WITH NOTES. All actionable findings were fixed;
  the record is in `PHOTO_PROGRAM_LOCAL_HANDOFF.md`.

## Owner-executed RC2 procedure and results

Target: product `cbf425ce-42b8-4fe7-8447-7be257c05a5b`, photo `a409ea88-2d1c-4f0d-97ce-9383230411ed`, operation
`5e535cba-a445-4dd4-a74c-91ae05f41563`, delete event `2a80310f-2ea3-46c2-aaa8-c83d62c6ac66`.

| Step | Result (owner-reported) |
| --- | --- |
| W2 upload (staging driver) | 201 |
| Pre-DELETE snapshot | committed operation and intent; two `pfs1:` copies |
| DELETE `/api/products/:id/photos/:photoId` | 200 |
| Batch `due` precheck (at `d0b28e2`) | **STOP**: unrelated older promote events were due. No batch scheduler call; no queue row edited. The STOP led to the exact-event route (`ea54de2`, `43b9bc3`). |
| Before snapshot preserved across the `43b9bc3` deploy | preserved on `/var/data` |
| Post-deploy `recheck` | 5/5 PASS (files, evidence and authority rows unchanged) |
| Exact-event `due-event` | 4/4 PASS |
| Exact-event dispatch | HTTP 200, `photoOutboxProcessed=1`, target event `Succeeded`, `attempts=1` |
| `results` | PASS (only the target photo's event dispatched) |
| Final `compare` | **9/9 PASS**: original committed evidence and `pfs1:` identities valid; photo row present then absent; one successful delete event, one attempt, no error; exactly its two canonical files removed; all other files unchanged, none added; operation/intent/copy evidence and all authority rows unchanged |

Evidence files on RC2 (owner-held): `/var/data/f2-4c-20261021/before.json`, `predispatch.json`,
`dispatch-response.json`, `after.json`. The retained blocked publication intents (`39271b8a…`, fixture `322cf602…`) were
not touched (authority rows unchanged in `compare`).

## 4C closure criteria (as recorded in the handoff; no new gates)

| Criterion | Status | Basis |
| --- | --- | --- |
| CODE (implementation, focused tests, independent review) | **PASS** | local suites on SQLite and disposable PostgreSQL 16.15; typecheck; reviews above |
| CI (exact-head scoped) | **PASS** | run `39622178082` on `43b9bc3` |
| RC2 (staging acceptance incl. confined `pfs1:` identity path) | **PASS** | owner-executed results above |
| PRODUCTION acceptance of fenced W8 deletion | **NOT RUN** | proposal prepared, not authorized |
| Owner acceptance of residuals and of replacing the W8 refusal | **OPEN** | see the proposal, §6 |

**4C is NOT CLOSED.** Production acceptance and the owner acceptance item remain.

## Scope limits

- **Verified scope:** SQLite, fencing ON, confinement `required`, single instance.
- **PostgreSQL:**
  - W8 deletion is deliberately fail-closed. Enabling it needs an order-side serialization contract, which is outside 4C.
  - Separately, a **pre-existing PostgreSQL outbox defect**: `outbox_events.payload` is JSONB (migration 0002), but the
    shared `parse()` calls `JSON.parse`, so PostgreSQL outbox reads (`getById`, `claimNextBatch`, `claimById`) throw on
    real rows. It is not fixed. PostgreSQL `claimById` is proven only by a mocked-query test.
- W6/W9 remain refused. W11/0042 is dormant and untouched. 4B is parked. F2 stays CLOSED 4/4; overall stays 5/12.
