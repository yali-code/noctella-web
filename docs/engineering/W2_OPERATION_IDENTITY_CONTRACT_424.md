# #424 / Stage 3A: W2 request-stable operation identity — contract and acceptance gates

**Status: DESIGN / NOT IMPLEMENTED. RELEASE BLOCKED.** Offline documentation only. This does not approve a route or DB contract change, production-root fencing, migration, cleanup or deployment.

## Source audit (2026-10-15)

- `apps/api/src/routes/productPhotoUpload.ts` (PR #414 ancestry) uses `mkdtemp(request-...)` as a transient request directory, an in-process photo admission lease and a call to `options.upload(productId, {path, workDir, size, mimetype, ...})`. The accepted multipart field set contains only `altText`. There is no client/request-stable idempotency identifier in the audited route.
- `apps/api/src/services/developmentPhotoStorageCapability.ts` has an operation ID, generation, owner nonce and sealed no-overwrite storage contract, but is explicitly development-only and must not be imported into production writer paths.
- `docs/engineering/P2-2B3D4_WRITER_ADOPTION.md` classifies W2 as DEPENDENT: request-directory ownership is not durable, and a real adoption requires row/outbox and durable operation authority in the same transaction.
- `apps/api/src/services/photoOwnershipFencing.ts` rejects unadopted W2 uploads when the fencing switch is ON; this refusal is not successful adoption.

## Proposed identity and retry contract (requires owner/client approval)

The proposal is a **separate contract**, not a silently deployed protocol:

1. A caller supplies a stable idempotency token per logical photo-upload intent, distinct from per-attempt internal nonce and server-owned generation. Do not generate a fresh token on every retry: doing so cannot correlate a lost acknowledgement.
2. Scope the token to the authenticated tenant/owner, authenticated admin actor as appropriate, the target Product ID, operation kind (W2 product-photo upload), and canonical input identity. Prevent cross-tenant reuse or guessing; do not treat user-chosen tokens as authority to access existing photos.
3. Resolve request metadata only after auth/authorization. Canonicalize input digest from verified streamed bytes, not untrusted declared MIME/filename. Record metadata necessary to distinguish **same intent** from **conflicting reuse**.
4. For exact same intent: return the existing committed photo result without a second canonical publication or outbox event, or safely resume a valid in-progress generation under the durable lease protocol.
5. If same token is reused for different Product ID, bytes, alt text/semantics or owner scope: reject with a stable conflict response. Never overwrite an earlier successful result.
6. On expired leases and concurrent retries, acquire/reclaim generation with DB-time, CAS, nonce uniqueness; stale generations may not publish, compensate or delete. File write fence must be checked at the mutation boundary, not just route entry.
7. Reserve all disk growth before ingress/publish (including raw/sealed copies, WAL and retained generations). If unable to reserve, reject before filesystem mutation, or retain safely under explicitly reconciled ownership.
8. Persist the operation-to-photo binding and resulting product-photo row/outbox in an appropriate atomic transaction. Treat uncertain COMMIT acknowledgement as **retain and inspect**; never erase potential committed bytes.
9. Server-side token retention must cover realistic client retries and operational recovery. Expiry, audit, privacy and cleanup are owner decisions; expiry must not turn previously published bytes into overwriteable targets.
10. Maintain flag-OFF compatibility until a versioned client/server opt-in is independently approved. Older clients lacking a stable key **cannot** be declared retry-idempotent.

## Non-negotiable test matrix before implementation acceptance

| Case | Required outcome |
| --- | --- |
| Initial upload and repeated identical token/body | One committed photo and one outbox intent; identical result |
| Two simultaneous identical tokens | One publisher wins; second waits/reuses or fails closed without duplicate |
| Same token, changed Product ID/actor/tenant/input/alt text | Deterministic conflict; no external media mutation |
| Lost response after successful DB COMMIT | Retry returns committed result; no compensation deletion |
| Crash after private seal, before DB COMMIT | Restart reconciliation retains evidence and permits safe generation-based recovery |
| Stale writer resumes after lease reclaim | Stale overwrite/compensation fails at real file mutation |
| File exists with different inode/hash | Conflict/review, never `rename` overwrite or blind unlink |
| Exhausted disk / ENOSPC during ingress and seal | No unowned canonical file; bounded partial retained/reviewed |
| Unavailable DB authority | Fail closed before canonical mutation |
| Unknown idempotency key / unauthenticated request | Existing auth checks; no token enumeration |
| Old binary remains running | No activation, until platform drain proven |
| Flag OFF | Existing request behavior and data contract unchanged |
| PostgreSQL and SQLite, SIGKILL before/after COMMIT | Atomic row/outbox binding and non-destructive recovery |

## Implementation gates / handoff

1. Decide client header/body token schema and error contract; ensure legacy multipart body still accepts only `altText` until a versioned change is approved.
2. Record durable identity and deterministic result linkage on both SQLite and PostgreSQL without migration collision with Etsy 0039/photo ownership 0040.
3. Add a pure, isolated identity/intent comparison module plus table-driven tests **before** changing the request handler. Do not invent a production implementation that ignores generation/transaction authority.
4. Integrate W2 through safe path-fed budget and sealed storage only after W4 authority review; preserve snapshot tests for feature-OFF.
5. Require real PostgreSQL + SQLite crash/fencing tests, writer census, complete CI, and updated runbook. No production launch from development-only proof.

**Verification boundary:** GitHub PR #422 validates a specific 24-MP synthetic memory path, not this unimplemented request-idempotency protocol. #424 remains the controlling consolidated issue.
