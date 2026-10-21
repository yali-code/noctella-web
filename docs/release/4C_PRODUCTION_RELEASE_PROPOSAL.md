# 4C production release proposal (#424): AUTHORIZED AND EXECUTED BY THE OWNER (21 October 2026)

Audience: the repository owner. Acceptance evidence is in `docs/engineering/4C_RC2_ACCEPTANCE_RECORD.md`.
- §1–§6 below are the **proposal as written before authorization**, kept unchanged as history.
- What actually happened is in the **Execution record** at the end. Every runtime action and result there was performed
  and reported by the owner.
- The agent performed no production read or action except read-only Render deploy metadata.

## 1. Exact release

| Item | Value |
| --- | --- |
| Deploy commit | **`43b9bc3af4be8ed89be35c95d59c26435485573e`**: the exact commit with CI run `39622178082` and RC2 acceptance. A later documentation-only commit on the branch has the same runtime tree but is **not** the CI/RC2-tested SHA; do not deploy it in place of `43b9bc3`. |
| Target | API `srv-db34390m7kps73cv8l6g` (`noctella-production-api`, `api.noctella.com`) only. Admin and storefront are unchanged. Auto-deploy is off. |
| Live baseline (read-only Render metadata) | `14f17469ed43fec4e3035d08612ea3b69cf849c3`, deploy `dep-dbbsrunavr4c73dggma0` (live since 2026-10-20 20:26Z), with fencing ON, confinement `required`, SQLite and admission paused (release package §7.1, owner-recorded) |
| Environment and secrets | **No change.** The build command is unchanged (it already includes `build:launcher`). |
| Schema | **No change.** There is no migration; `ensureSchema` is unchanged. |

## 2. Runtime delta `14f1746..43b9bc3` (8 API source files; everything else is tests, CI, scripts and docs)

| File | Origin | Effect |
| --- | --- | --- |
| `apps/api/src/scripts/photoReleasePreflight.ts` | inherited #494 (`71b5ea6`) | operator-run preflight: canonical-parent device checks; SQLite vs PostgreSQL backup-driver classification |
| `apps/api/src/services/photoCanonicalDeletion.ts` | 4C | new authorized deleter; PostgreSQL retains |
| `apps/api/src/services/productPhotoStorageWorkflow.ts` | 4C | fenced W8 uses the deleter; fencing-OFF unchanged |
| `apps/api/src/services/productPhotoOutboxDispatcher.ts` | 4C | wires the deleter; exact-event dispatch helper |
| `apps/api/src/services/photoCopyPublisher.ts` | 4C | `export` of an existing hash helper only |
| `apps/api/src/services/outbox.ts`, `outboxRepository.ts` | 4C | `claimById` (the batch claim predicate plus `id`), `dispatchClaimableEvent` |
| `apps/api/src/app.ts` | 4C | two scheduler-authenticated routes: `/api/background-jobs/product-photo-outbox/run` and `/product-photo-outbox/dispatch-event` |

`14f1746..35bd482` (#494) adds no other runtime change. Its remaining changes are tests, CI, the runbook and docs.

**Behavioral consequence in production (activation).** With fencing ON, every product-photo delete event becomes
eligible for authorized canonical deletion. This includes events processed by the existing hourly
`noctella-production-background-jobs` cron (`/api/background-jobs/run`; its target URL was not read). Deletion is
irreversible except from backups. Until now, production delete events were refused and dead-lettered. Dead-lettered
events are not re-dispatched.

## 3. Existing procedures that apply (release package §3)

1. **Backups before deploy:**
   - `npm run db:backup -w apps/api` and `npm run photos:backup -w apps/api`;
   - `npm run db:restore-verify -w apps/api` on the new key (record byte size, sha256 and integrity);
   - note the latest Render disk snapshot time.
2. **Quiescence (§3 activation steps 3–4):**
   - photo admission stays stopped (currently paused);
   - no in-flight requests;
   - `photos:operations-report` shows no `preparing`/`sealed` operation with a live lease;
   - **the outbox has no pending photo promote/delete events**. Read-only check:

     `node ../../scripts/photo-staging-acceptance/4c-evidence.cjs due none`

     It must print `PASS` (any due product-photo event, or a stale non-photo lock, prints STOP).
   - `photos:publication-intents` shows zero `authorized` intents.
3. **Exact-commit manual deploy** of `43b9bc3`. Verify no-overlap from the Render event and service logs: the old
   instance's shutdown precedes the new instance's first start line.
4. **Post-deploy target check and preflight** (production shell, from `apps/api`):

   `test "$RENDER_SERVICE_ID" = srv-db34390m7kps73cv8l6g && test "$RENDER_GIT_COMMIT" = 43b9bc3af4be8ed89be35c95d59c26435485573e && test "${DATABASE_DRIVER:-sqlite}" = sqlite && test "$PHOTO_OWNERSHIP_FENCING_ENABLED" = true && test "$PHOTO_PREPARATION_CONFINEMENT" = required && echo TARGET-OK && npm run photos:release-preflight`

   Expect no FAIL; WARN only `migrations.gaps` and `storage.free-space` as recorded.
5. **Rollback (code only; fencing stays ON):**
   - an exact-commit manual redeploy of `14f17469…` restores the W8 refusal and removes both new routes;
   - no schema or data step is needed;
   - files already deleted stay deleted, and can be restored only from `photos:backup`;
   - processed events stay `Succeeded`.

   The §3 fencing-rollback order applies only if fencing itself is turned off, which is not proposed.

## 4. Minimum production acceptance (the recorded 4C criterion: production acceptance of fenced W8 deletion)

The candidate is the existing Stage 4 test photo. It was the single `product_upload` uploaded under fencing at `14f1746`
(§7.1, photos 156 → 157), and it is recorded as "cannot be deleted while fencing is ON". It is a test photo on a test
product, not customer media. Production shell, from `apps/api`:

```bash
E=../../scripts/photo-staging-acceptance/4c-evidence.cjs
DIR=/var/data/f2-4c-prod-$(date -u +%Y%m%d)
```

| Step | Action | Expected / stop |
| --- | --- | --- |
| a | `node -e 'const D=require(require.resolve("better-sqlite3",{paths:[process.cwd()]}));const db=new D(process.env.DATABASE_URL,{readonly:true,fileMustExist:true});console.log(JSON.stringify(db.prepare("SELECT o.target_photo_id, o.state, i.state AS intent, p.product_id FROM photo_operations o LEFT JOIN photo_publication_intents i ON i.operation_id = o.id LEFT JOIN product_photos p ON p.id = o.target_photo_id").all()))'` | exactly one row, `committed`/`committed`; the owner confirms that the product is the Stage 4 test product. Set `PHOTO_ID`. Otherwise STOP. |
| b | `mkdir -p $DIR && node $E snapshot $PHOTO_ID > $DIR/before.json` | committed op and intent, two `pfs1:` copies |
| c | Delete that photo through the Admin UI or `DELETE /api/products/<testProductId>/photos/$PHOTO_ID` | 200 |
| d | Look up its delete event id (read-only query as in the RC2 procedure), then `node $E due-event $PHOTO_ID $EVENT_ID` | 4× PASS. If the hourly cron already processed it (status `Succeeded`), skip e–f and go to g. |
| e | `curl -s -X POST -H "Authorization: Bearer $SCHEDULER_AUTH_TOKEN" -H 'content-type: application/json' -d "{\"eventId\":\"$EVENT_ID\"}" https://api.noctella.com/api/background-jobs/product-photo-outbox/dispatch-event > $DIR/dispatch-response.json` | 200, `Succeeded`, `attempts: 1`; a 409 means STOP |
| f | `node $E results $PHOTO_ID $DIR/dispatch-response.json` | PASS |
| g | `node $E snapshot $PHOTO_ID > $DIR/after.json && node $E compare $DIR/before.json $DIR/after.json` | 9× PASS |

On any STOP or FAIL: files are retained, nothing is retried, outputs are kept, and rollback is per §3.5 if the owner
decides. Do not run b–g across a deploy. Production retains its evidence under `$DIR`.

## 5. Scope

- **Verified:** SQLite, fencing ON, confinement `required`, single instance (RC2 acceptance plus CI).
- **PostgreSQL:**
  - W8 deletion is fail-closed by design.
  - The pre-existing JSONB/`parse()` outbox defect is unfixed, so PostgreSQL outbox processing would fail on real rows.
  - Neither affects production, which is SQLite.
  - A future PostgreSQL cutover needs both fixed and separately accepted.

## 6. Owner authorizations required (none is granted by this document)

1. Accept the 4C residuals:
   - the operator-only constraint that no manual canonical-root writes occur during deletion processing;
   - the SQLite write lock held during reference scans and the `pfs1:` probes;
   - safe retention of legacy and unknown-ownership files;
   - PostgreSQL fail-closed, plus the unfixed PostgreSQL outbox defect.

   Also accept replacing the accepted "canonical deletion refused" limitation.
2. Authorize production backups, quiescence checks and the exact-commit deploy of `43b9bc3` (§3), including activation of
   deletion through the hourly cron.
3. Authorize the §4 test-photo deletion, which permanently deletes that test photo's two canonical files.
4. Separately, decide whether and how #494/#495 merge (GitHub work). This is independent of the Render deploy, which
   references the exact commit.

Normal-use resumption is **not** included and remains a separate owner decision. 4C closes only after §4 PASS and item 1.
F2 stays CLOSED 4/4; overall stays 5/12.

## Execution record (owner-executed, 21 October 2026; owner-reported results)

| Proposal item | Completed action and result |
| --- | --- |
| §6.1 residuals and replacing the W8 refusal | **Accepted** by the owner: the documented SQLite/fencing-ON limits, production deletion activation and the test-photo deletion |
| §3.1 backups | `db:backup` and `photos:backup` HTTP 200. `db:restore-verify` on key `database-backups/noctella-sqlite-20261021T153435624Z-5a3b13df3f2b4a7c.sqlite`: bytes 2,953,216, sha256 `5a3b13df3f2b4a7c65aaa06d7af152f77cfbbc833d44e7f1f76397ff78ecae73`, integrity **ok**. Disk snapshot 21 October 2026 at 3:41 AM (display timezone unspecified). |
| §3.2 quiescence | no due or Processing photo events, no attention or rollback blockers, publication-intents report empty |
| §3.3 exact-commit deploy | `dep-dbcdqo3ncjis7396qv80` live at `43b9bc3af4be8ed89be35c95d59c26435485573e`. No-overlap **PASS**: old instance shutdown complete 2026-10-21 15:44:41.104929342Z; new instance `tmkj8` Running 15:45:24Z (the owner's screenshot displayed 06:45:24 PM local time). |
| §3.4 target check and preflight | correct commit, SQLite, fencing ON, Landlock confinement, `pfs1:` PASS, no FAIL |
| §4 test-photo acceptance | target confirmed by the owner: product `aa61360f-45ee-46b6-8079-c7a62ee83e83` (NOC-000013), photo `0594af1a-68ad-4286-8286-8daa5e9ab9f8`, operation `38829870-5b8a-47f5-bdae-540d174e2ccc`, delete event `0867bdf8-f697-4f9b-8ab1-10bd94c91c06`. Steps and results: <br>• deleted through Admin <br>• `due-event` 4/4 PASS <br>• dispatch HTTP 200, `photoOutboxProcessed=1`, `Succeeded`, `attempts=1` <br>• `results` PASS <br>• `compare` 9/9 PASS: exactly its two canonical files removed, all other files unchanged, none added, all operation/intent/copy evidence and authority rows unchanged <br>• file inventory 318 → 316 |
| Evidence location | `/var/data/4c-prod-20261021/` (`before.json`, `dispatch-response.json`, `after.json`). The proposal had suggested `/var/data/f2-4c-prod-<date>`; the owner used this directory. |
| §3.5 rollback | not needed; not executed |
| §6.4 #494/#495 merge | not part of this execution; still a separate decision |

**Outcome:** production acceptance of fenced W8 deletion PASS. **4C CLOSED** within SQLite, fencing ON, confinement
`required` and a single instance (closure table in `docs/engineering/4C_RC2_ACCEPTANCE_RECORD.md`).
- Production now runs `43b9bc3`. Canonical deletion is active under fencing, including through the hourly
  background-jobs cron.
- Normal-use resumption remains deferred.
- PostgreSQL deletion stays fail-closed, and the PostgreSQL JSONB outbox `parse()` defect remains unfixed. No PostgreSQL
  runtime acceptance exists or is implied.
- F2 stays CLOSED 4/4; overall stays 5/12.
