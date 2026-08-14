import crypto from "node:crypto";
import { and, desc, eq, SQL } from "drizzle-orm";
import { MarketplaceConnectionStatus, ProductStatus, PublishChannel, PublishJobStatus, PUBLISH_CHANNEL_VALUES, type ExternalListing, type MarketplaceConnection, type PublishAttempt, type PublishExecutionResult, type PublishJob, type UnifiedPublishChannelResult, type UnifiedPublishResult } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { externalListings, marketplaceConnections, publishAttempts, publishJobs } from "../db/schema";
import { BadRequestError, ConflictError, DuplicateActiveListingError, NotFoundError, ProductVersionConflictError } from "./errors";
import { getProductById, updateProduct } from "./products";
import { buildPublishPayload, validatePublish } from "./publishing";
import { decryptCredential, encryptCredential } from "./credentialEncryption";
import { getMarketplaceAdapter, type MarketplaceAdapter } from "./marketplaceAdapters";
import { createOAuthState, verifyOAuthState } from "./oauthState";

const supported = [PublishChannel.Ebay, PublishChannel.Etsy];
function now() { return new Date().toISOString(); }
function id(prefix: string) { return `${prefix}_${crypto.randomUUID()}`; }
function assertChannel(channel: PublishChannel) { if (!supported.includes(channel)) throw new BadRequestError("Unsupported marketplace channel"); }
/**
 * Sprint 84: executePublish-only channel check. Noctella Web is our own direct storefront, not an
 * external marketplace - it must never enter the OAuth/MarketplaceConnection/adapter machinery
 * gated by assertChannel/`supported` above, which getConnection/startConnect/completeConnect/
 * disconnect continue to use unchanged (they correctly keep rejecting NoctellaWeb). This check
 * only widens what executePublish itself accepts, to the full set of real PublishChannel values,
 * while still rejecting a genuinely bogus value the same way assertChannel does.
 */
function assertKnownPublishChannel(channel: PublishChannel) { if (!PUBLISH_CHANNEL_VALUES.includes(channel)) throw new BadRequestError("Unsupported marketplace channel"); }
function parse<T>(v: string | null | undefined, fallback: T): T { return v ? JSON.parse(v) as T : fallback; }
export function sanitizeMarketplaceError(e: unknown) { return e instanceof Error ? e.message.replace(/[A-Za-z0-9+/=_-]{8,}/g, "[redacted]") : "Marketplace request failed"; }
/**
 * Sprint 62B: statuses an adapter is known to report for a listing that is no longer live.
 * Anything not in this set (including an unrecognized/ambiguous status) is treated as blocking,
 * never as safely terminal - see executePublish's duplicate-active-listing guard.
 */
const TERMINAL_EXTERNAL_LISTING_STATUSES = new Set(["ended", "inactive", "sold", "closed"]);
function isTerminalListingStatus(status: string): boolean { return TERMINAL_EXTERNAL_LISTING_STATUSES.has(String(status ?? "").toLowerCase()); }
function conn(row: typeof marketplaceConnections.$inferSelect): MarketplaceConnection { return { id: row.id, channel: row.channel as PublishChannel, accountLabel: row.accountLabel, externalAccountId: row.externalAccountId ?? undefined, tokenExpiresAt: row.tokenExpiresAt ?? undefined, scopes: parse(row.scopes, []), status: row.status as MarketplaceConnectionStatus, lastError: row.lastError ?? undefined, createdAt: row.createdAt, updatedAt: row.updatedAt }; }
function job(row: typeof publishJobs.$inferSelect): PublishJob { return { id: row.id, productId: row.productId, channel: row.channel as PublishChannel, status: row.status as PublishJobStatus, idempotencyKey: row.idempotencyKey, payloadSnapshot: JSON.parse(row.payloadSnapshot), externalListingId: row.externalListingId ?? undefined, externalListingUrl: row.externalListingUrl ?? undefined, attemptCount: row.attemptCount, lastError: row.lastError ?? undefined, createdAt: row.createdAt, updatedAt: row.updatedAt, completedAt: row.completedAt ?? undefined }; }
function listing(row: typeof externalListings.$inferSelect): ExternalListing { return { id: row.id, productId: row.productId, channel: row.channel as PublishChannel, connectionId: row.connectionId, externalListingId: row.externalListingId, externalListingUrl: row.externalListingUrl ?? undefined, externalStatus: row.externalStatus, payloadSnapshot: JSON.parse(row.payloadSnapshot), publishedAt: row.publishedAt, updatedAt: row.updatedAt }; }
function attempt(row: typeof publishAttempts.$inferSelect): PublishAttempt { return { id: row.id, publishJobId: row.publishJobId, attemptNumber: row.attemptNumber, requestSnapshot: JSON.parse(row.requestSnapshot), responseSnapshot: parse(row.responseSnapshot, undefined), errorCode: row.errorCode ?? undefined, errorMessage: row.errorMessage ?? undefined, createdAt: row.createdAt }; }
export function getAdapter(channel: PublishChannel, adapter?: MarketplaceAdapter) { return adapter ?? getMarketplaceAdapter(channel); }

export async function listConnections(db: DbClient) { return (await db.select().from(marketplaceConnections)).map(conn); }
export async function getConnection(db: DbClient, channel: PublishChannel) { assertChannel(channel); const [r] = await db.select().from(marketplaceConnections).where(eq(marketplaceConnections.channel, channel)); return r ? conn(r) : undefined; }
export async function startConnect(channel: PublishChannel, accountLabel = "Default", adapter?: MarketplaceAdapter) { assertChannel(channel); const state = createOAuthState(channel, accountLabel); return { authorizationUrl: getAdapter(channel, adapter).getAuthorizationUrl(state), state, accountLabel }; }
export async function completeConnect(db: DbClient, channel: PublishChannel, code: string, state: string, _expectedState = "", accountLabel="Default", adapter?: MarketplaceAdapter) { assertChannel(channel); try { accountLabel = verifyOAuthState(state, channel).accountLabel || accountLabel; } catch (e) { throw new BadRequestError(e instanceof Error ? e.message : "OAuth state mismatch"); } const tokens = await getAdapter(channel, adapter).exchangeAuthorizationCode(code); const record = { id: id("conn"), channel, accountLabel, externalAccountId: tokens.externalAccountId, encryptedAccessToken: encryptCredential(tokens.accessToken), encryptedRefreshToken: tokens.refreshToken ? encryptCredential(tokens.refreshToken) : null, tokenExpiresAt: tokens.expiresAt, scopes: JSON.stringify(tokens.scopes ?? []), status: MarketplaceConnectionStatus.Connected, lastError: null, updatedAt: now() }; await db.insert(marketplaceConnections).values({ ...record, createdAt: now() }).onConflictDoUpdate({ target: [marketplaceConnections.channel, marketplaceConnections.accountLabel], set: record }); return (await getConnection(db, channel))!; }
async function active(db: DbClient, channel: PublishChannel) { const [r] = await db.select().from(marketplaceConnections).where(and(eq(marketplaceConnections.channel, channel), eq(marketplaceConnections.status, MarketplaceConnectionStatus.Connected))); if (!r?.encryptedAccessToken) throw new BadRequestError("Marketplace connection is not connected"); if (r.tokenExpiresAt && Date.parse(r.tokenExpiresAt) <= Date.now()) throw new BadRequestError("Marketplace connection is expired"); return r; }
export async function refreshConnection(db: DbClient, channel: PublishChannel, adapter?: MarketplaceAdapter) { const r = await active(db, channel); if (!r.encryptedRefreshToken) throw new BadRequestError("Refresh token is unavailable"); const tokens = await getAdapter(channel, adapter).refreshAccessToken(decryptCredential(r.encryptedRefreshToken)); await db.update(marketplaceConnections).set({ encryptedAccessToken: encryptCredential(tokens.accessToken), encryptedRefreshToken: tokens.refreshToken ? encryptCredential(tokens.refreshToken) : r.encryptedRefreshToken, tokenExpiresAt: tokens.expiresAt, scopes: JSON.stringify(tokens.scopes ?? parse(r.scopes, [])), status: MarketplaceConnectionStatus.Connected, updatedAt: now() }).where(eq(marketplaceConnections.id, r.id)); return (await getConnection(db, channel))!; }
export async function verifyConnection(db: DbClient, channel: PublishChannel, adapter?: MarketplaceAdapter) { const r = await active(db, channel); try { await getAdapter(channel, adapter).verifyConnection(decryptCredential(r.encryptedAccessToken!)); await db.update(marketplaceConnections).set({ lastError: null, updatedAt: now() }).where(eq(marketplaceConnections.id, r.id)); return { ok: true, connection: (await getConnection(db, channel))! }; } catch (e) { const msg = sanitizeMarketplaceError(e); await db.update(marketplaceConnections).set({ status: MarketplaceConnectionStatus.Error, lastError: msg, updatedAt: now() }).where(eq(marketplaceConnections.id, r.id)); return { ok: false, error: msg, connection: (await getConnection(db, channel))! }; } }
export async function disconnect(db: DbClient, channel: PublishChannel) { assertChannel(channel); const [r] = await db.select().from(marketplaceConnections).where(eq(marketplaceConnections.channel, channel)); if (!r) return undefined; await db.update(marketplaceConnections).set({ encryptedAccessToken: null, encryptedRefreshToken: null, status: MarketplaceConnectionStatus.Revoked, updatedAt: now() }).where(eq(marketplaceConnections.id, r.id)); return (await getConnection(db, channel))!; }
/**
 * Sprint 84 correction: atomically inserts one PublishJob + one PublishAttempt for a successful
 * Noctella Web direct publication. Branches on the active DATABASE_DRIVER because SQLite
 * (drizzle-orm/better-sqlite3) and Postgres (drizzle-orm/node-postgres) have genuinely
 * incompatible transaction APIs - confirmed by inspecting db/runtime.ts (Postgres uses
 * drizzlePostgres(pool,...)) and every real Postgres repository in this codebase (e.g.
 * repositories/sales-completion/postgres.ts), none of which ever call `.run()`: SQLite requires a
 * synchronous transaction callback and exposes `.run()` for in-callback execution; Postgres
 * requires an async callback, and its insert builders are plain awaited promises with no `.run()`
 * method at all. A single untyped callback body cannot correctly serve both, so this helper
 * branches and uses the driver-correct API in each case, rather than a blanket `(db as any)` cast
 * that would silently hide the mismatch from the type checker. The SQLite branch uses DbClient
 * natively (no cast needed - it already is the SQLite drizzle type). The Postgres branch narrows
 * only `db` itself to `any`, matching this codebase's own established convention for Postgres-path
 * code with no dedicated client type (e.g. createPostgresSalesCompletionTransactionRepository's
 * `db: any` parameter in repositories/sales-completion/postgres.ts).
 *
 * Known residual limitation (pre-existing, whole-file, not introduced or fixed by this
 * correction): every table this file references - including `publishJobs`/`publishAttempts` used
 * here - is imported from ../db/schema, which re-exports exclusively from schema.sqlite.ts. A real
 * Postgres client (drizzle-orm/node-postgres, constructed against schema.postgres.ts's separately
 * defined pgTable objects) cannot correctly execute a query built against a sqliteTable reference.
 * This branch's driver check fixes the specific transaction-callback/`.run()` API mismatch the
 * Exact Review identified, but full Postgres correctness for this file - for this new code and for
 * every pre-existing eBay/Etsy write in it - additionally requires schema-aware table selection
 * matching the pattern already used by the postgres.ts files under apps/api/src/repositories,
 * which is out of this correction's approved scope (no new abstraction, eBay/Etsy path unchanged).
 */
async function insertDirectPublishAudit(db: DbClient, jobRow: typeof publishJobs.$inferInsert, attemptRow: typeof publishAttempts.$inferInsert): Promise<void> {
  const isPostgres = process.env.DATABASE_DRIVER === "postgres" || process.env.DATABASE_DRIVER === "supabase-postgres";
  if (isPostgres) {
    const pgDb = db as any;
    await pgDb.transaction(async (tx: any) => {
      await tx.insert(publishJobs).values(jobRow);
      await tx.insert(publishAttempts).values(attemptRow);
    });
    return;
  }
  db.transaction((tx) => {
    tx.insert(publishJobs).values(jobRow).run();
    tx.insert(publishAttempts).values(attemptRow).run();
  });
}
/**
 * Sprint 84: Noctella Web direct-channel execution. Reached only after product lookup and
 * successful validation have already passed in executePublish, and strictly before active()/any
 * adapter logic - this branch must never touch MarketplaceConnection or a marketplace adapter.
 * product.status is the sole Storefront-visibility source of truth (see publicCatalog.ts), so the
 * only durable side effect that matters is the canonical updateProduct/product-write use-case
 * call; the PublishJob+PublishAttempt pair exists purely for audit/history parity with the
 * eBay/Etsy flow (same idempotency-key format/lookup, same payload/attempt-count conventions) and
 * intentionally creates no ExternalListing.
 */
async function executeNoctellaWebPublish(db: DbClient, productId: string, product: Awaited<ReturnType<typeof getProductById>>, channel: PublishChannel, key?: string): Promise<PublishExecutionResult> {
  const payload = buildPublishPayload(product, product.images, channel);
  const idem = key ?? `${productId}:${channel}:${crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
  const [existing] = await db.select().from(publishJobs).where(eq(publishJobs.idempotencyKey, idem));
  if (existing) return { job: job(existing) };
  // Sprint 84: updateProduct opens its own self-contained transaction internally (via
  // updateProductWithInventoryUseCase's UnitOfWork) and is async - it cannot be composed inside a
  // single synchronous db.transaction() callback alongside the two inserts below without either
  // breaking that callback's synchronous contract or nesting an unrelated transaction inside it.
  // Running it first, on its own, is the safest available order with existing infrastructure: if a
  // crash happens between this call and the inserts below, the product is already correctly
  // Published (the durable outcome that matters) and a retry with the same idempotency key simply
  // re-runs this same idempotent status write before completing the job/attempt pair.
  await updateProduct(db, productId, { status: ProductStatus.Published });
  const t = now();
  const jid = id("job");
  const requestSnapshot = JSON.stringify(payload);
  const responseSnapshot = JSON.stringify({ direct: true, channel: PublishChannel.NoctellaWeb, productStatus: ProductStatus.Published, publishedAt: t });
  // Sprint 84 correction: the job row and its one attempt are constructed completely, with a known
  // ID, before entering the transaction - so both drivers commit the exact same known row and
  // neither depends on driver-specific `.returning()` behavior. See insertDirectPublishAudit for
  // why SQLite and Postgres need genuinely different transaction code, not one shared `any` body.
  await insertDirectPublishAudit(
    db,
    { id: jid, productId, channel, status: PublishJobStatus.Succeeded, idempotencyKey: idem, payloadSnapshot: JSON.stringify(payload), attemptCount: 1, createdAt: t, updatedAt: t, completedAt: t },
    { id: id("att"), publishJobId: jid, attemptNumber: 1, requestSnapshot, responseSnapshot, createdAt: t },
  );
  const [r] = await db.select().from(publishJobs).where(eq(publishJobs.id, jid));
  return { job: job(r) };
}
export async function executePublish(db: DbClient, productId: string, channel: PublishChannel, key?: string, adapter?: MarketplaceAdapter): Promise<PublishExecutionResult> { assertKnownPublishChannel(channel); const product = await getProductById(db, productId); const validation = validatePublish(product, channel); if (!validation.valid) throw new BadRequestError("Publish validation failed"); if (channel === PublishChannel.NoctellaWeb) return executeNoctellaWebPublish(db, productId, product, channel, key); const connection = await active(db, channel); const payload = buildPublishPayload(product, product.images, channel); const idem = key ?? `${productId}:${channel}:${crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`; const [existing] = await db.select().from(publishJobs).where(eq(publishJobs.idempotencyKey, idem)); if (existing) return { job: job(existing), externalListing: existing.externalListingId ? (await listExternalListings(db, productId)).find((l) => l.externalListingId === existing.externalListingId) : undefined };
  const sameChannelListings = await db.select().from(externalListings).where(and(eq(externalListings.productId, productId), eq(externalListings.channel, channel)));
  if (sameChannelListings.some((l) => !isTerminalListingStatus(l.externalStatus))) throw new DuplicateActiveListingError();
  const jid = id("job"); await db.insert(publishJobs).values({ id: jid, productId, channel, status: PublishJobStatus.Processing, idempotencyKey: idem, payloadSnapshot: JSON.stringify(payload), attemptCount: 0, createdAt: now(), updatedAt: now() });
  try { const result = await getAdapter(channel, adapter).createListing(decryptCredential(connection.encryptedAccessToken!), payload); await db.insert(publishAttempts).values({ id: id("att"), publishJobId: jid, attemptNumber: 1, requestSnapshot: JSON.stringify(payload), responseSnapshot: JSON.stringify(result.raw ?? result), createdAt: now() }); const lid = id("ext"); await db.insert(externalListings).values({ id: lid, productId, channel, connectionId: connection.id, externalListingId: result.externalListingId, externalListingUrl: result.externalListingUrl, externalStatus: result.externalStatus, payloadSnapshot: JSON.stringify(payload), publishedAt: now(), updatedAt: now() }).onConflictDoNothing(); await db.update(publishJobs).set({ status: PublishJobStatus.Succeeded, externalListingId: result.externalListingId, externalListingUrl: result.externalListingUrl, attemptCount: 1, completedAt: now(), updatedAt: now() }).where(eq(publishJobs.id, jid)); } catch(e) { const err = getAdapter(channel, adapter).normalizeError(e); await db.insert(publishAttempts).values({ id: id("att"), publishJobId: jid, attemptNumber: 1, requestSnapshot: JSON.stringify(payload), errorCode: err.code, errorMessage: err.message, createdAt: now() }); await db.update(publishJobs).set({ status: err.retryable ? PublishJobStatus.RetryPending : PublishJobStatus.Failed, attemptCount: 1, lastError: err.message, updatedAt: now() }).where(eq(publishJobs.id, jid)); }
  const [r] = await db.select().from(publishJobs).where(eq(publishJobs.id, jid)); return { job: job(r) }; }
/**
 * Sprint 141: thin, additive orchestration around the existing authoritative executePublish above -
 * never a second publishing implementation. Attempts every selected channel, in the caller's given
 * order, strictly SEQUENTIALLY (no Promise.all, no cross-channel transaction - external marketplace
 * calls are not atomically reversible, and only 3 PublishChannel values ever exist, so throughput is
 * not a concern). One channel's outcome never affects whether a later selected channel is attempted,
 * and never rolls back an earlier channel's already-committed result - each channel keeps executing
 * through its own existing transaction/persistence exactly as executePublish already provides.
 * Duplicate channel values in the input are deduplicated (first occurrence kept, stable order),
 * never rejected - a harmless repeated selection should not fail the whole request.
 *
 * Classification is deliberately NOT a plain try/catch: executePublish itself never throws for an
 * adapter/provider failure (that is caught internally and persisted as a PublishJob already in
 * RetryPending/Failed status - see executePublish's own eBay/Etsy catch block above), so a resolved
 * call must be classified by its actual PublishJob.status, never assumed "succeeded" merely because
 * it did not throw.
 *
 * Sprint 141 Formal Validation Fix: the catch branch below is deliberately NOT a bare
 * `instanceof ConflictError` check. executePublish's reachable call graph can throw MORE than one
 * ConflictError subtype - specifically, the Noctella Web branch's updateProduct call (inside
 * executeNoctellaWebPublish) can throw ProductVersionConflictError (also a ConflictError subclass)
 * under a genuine concurrent Product write. Only the dedicated DuplicateActiveListingError (thrown
 * exclusively by the duplicate-active-listing guard above) maps to the non-destructive "skipped"
 * outcome; every other recognized domain error (including ProductVersionConflictError) maps to
 * "failed" - a genuine version conflict must never be reported to the Admin as "already published".
 *
 * No batch-level idempotency key exists or is accepted - each channel always uses executePublish's
 * own existing default per-channel key (`key` is passed through as undefined here), preserving the
 * existing per-channel idempotency/duplicate-active-listing protection unchanged.
 *
 * Sprint 146: `expectedUpdatedAt` is now a required whole-batch precondition, checked once, up
 * front, before any selected channel is attempted - reuses the existing Sprint 88
 * ProductVersionConflictError (never a second versioning mechanism). This closes the gap where the
 * canonical Product Edit workspace's Save-before-Publish flow could otherwise publish a Product
 * whose fields the admin no longer believes are current (e.g. a concurrent edit landed between the
 * admin's last Save and clicking Publish Selected). A stale token blocks the ENTIRE batch - zero
 * adapter invocation, zero PublishJob/PublishAttempt/ExternalListing rows, no Product mutation -
 * never a per-channel "failed" result reached only after an earlier channel already published.
 */
export async function executePublishBatch(db: DbClient, productId: string, channels: PublishChannel[], expectedUpdatedAt: string, adapter?: MarketplaceAdapter): Promise<UnifiedPublishResult> {
  // A missing Product is a whole-request failure (404), never a per-channel outcome - checked once,
  // up front, and deliberately left OUTSIDE the per-channel try/catch below so NotFoundError
  // propagates to the route unchanged, exactly like every other Product-scoped route in this file.
  const product = await getProductById(db, productId);

  // Sprint 146: the whole-batch version gate - deliberately BEFORE any channel loop iteration, so a
  // stale token can never let an earlier selected channel commit before the conflict is detected.
  if (product.updatedAt !== expectedUpdatedAt) {
    throw new ProductVersionConflictError(productId, expectedUpdatedAt, product.updatedAt);
  }

  const seen = new Set<PublishChannel>();
  const ordered: PublishChannel[] = [];
  for (const channel of channels) {
    if (seen.has(channel)) continue;
    seen.add(channel);
    ordered.push(channel);
  }

  const results: UnifiedPublishChannelResult[] = [];
  for (const channel of ordered) {
    try {
      const result = await executePublish(db, productId, channel, undefined, adapter);
      if (result.job.status === PublishJobStatus.Succeeded) {
        results.push({ channel, outcome: "succeeded", result });
      } else {
        // Sprint 141: reached without throwing (e.g. an adapter/provider failure executePublish
        // already caught internally) - the PublishJob's own status (RetryPending/Failed) is the
        // truth, never "succeeded" merely because the call resolved.
        results.push({ channel, outcome: "failed", result, error: { message: result.job.lastError ?? "Publish attempt did not succeed" } });
      }
    } catch (err) {
      if (err instanceof DuplicateActiveListingError) {
        // The exact, narrow duplicate-active-listing condition only - never any other ConflictError.
        results.push({ channel, outcome: "skipped", error: { message: err.message } });
      } else if (err instanceof BadRequestError || err instanceof ConflictError || err instanceof NotFoundError) {
        // Sprint 141 Formal Validation Fix: these are the established domain/service error classes
        // whose message is already intentionally exposed to the client by the existing
        // routes/errorHandler.ts handleRouteError contract elsewhere in this codebase (every one of
        // BadRequestError/ConflictError/NotFoundError renders err.message verbatim there) - safe to
        // expose here too, by that same existing contract. ProductVersionConflictError (a
        // ConflictError subclass) is correctly included in this branch, never the "skipped" one above.
        results.push({ channel, outcome: "failed", error: { message: err.message } });
      } else {
        // Sprint 141 Formal Validation Fix: an unrecognized exception (a raw DB/driver error, an
        // unexpected runtime exception, or a non-Error thrown value) never reaches
        // routes/errorHandler.ts's own sanitization boundary from here - this catch is entirely
        // internal to executePublishBatch, which never re-throws. A fixed safe fallback is used
        // instead of the raw message, mirroring handleRouteError's own final fallback ("Internal
        // server error") for exactly the same class of unrecognized failure.
        results.push({ channel, outcome: "failed", error: { message: "Publish failed" } });
      }
    }
  }

  return { productId, results };
}
export async function listExternalListings(db: DbClient, productId: string) { return (await db.select().from(externalListings).where(eq(externalListings.productId, productId))).map(listing); }
export async function listPublishJobs(db: DbClient, filters: { channel?: PublishChannel; status?: PublishJobStatus; limit?: number; offset?: number } = {}) { const clauses: SQL[] = []; if (filters.channel) clauses.push(eq(publishJobs.channel, filters.channel)); if (filters.status) clauses.push(eq(publishJobs.status, filters.status)); const q = db.select().from(publishJobs).where(clauses.length ? and(...clauses) : undefined).orderBy(desc(publishJobs.createdAt)).limit(Math.min(filters.limit ?? 50, 100)).offset(filters.offset ?? 0); return (await q).map(job); }
export async function getPublishJob(db: DbClient, idv: string) { const [r] = await db.select().from(publishJobs).where(eq(publishJobs.id, idv)); if (!r) throw new NotFoundError("Publish job not found"); const atts = await db.select().from(publishAttempts).where(eq(publishAttempts.publishJobId, idv)); return { job: job(r), attempts: atts.map(attempt) }; }
export async function retryPublishJob(db: DbClient, idv: string, adapter?: MarketplaceAdapter) { const { job: j } = await getPublishJob(db, idv); const max = Number(process.env.MARKETPLACE_PUBLISH_MAX_RETRIES ?? 3); if (j.status !== PublishJobStatus.RetryPending || j.attemptCount >= max) throw new ConflictError("Publish job is not retryable"); const connection = await active(db, j.channel); const attemptNumber = j.attemptCount + 1; try { const result = await getAdapter(j.channel, adapter).createListing(decryptCredential(connection.encryptedAccessToken!), j.payloadSnapshot); await db.insert(publishAttempts).values({ id: id("att"), publishJobId: idv, attemptNumber, requestSnapshot: JSON.stringify(j.payloadSnapshot), responseSnapshot: JSON.stringify(result.raw ?? result), createdAt: now() }); await db.insert(externalListings).values({ id: id("ext"), productId: j.productId, channel: j.channel, connectionId: connection.id, externalListingId: result.externalListingId, externalListingUrl: result.externalListingUrl, externalStatus: result.externalStatus, payloadSnapshot: JSON.stringify(j.payloadSnapshot), publishedAt: now(), updatedAt: now() }).onConflictDoNothing(); await db.update(publishJobs).set({ status: PublishJobStatus.Succeeded, externalListingId: result.externalListingId, externalListingUrl: result.externalListingUrl, attemptCount: attemptNumber, lastError: null, completedAt: now(), updatedAt: now() }).where(eq(publishJobs.id, idv)); } catch (e) { const err = getAdapter(j.channel, adapter).normalizeError(e); await db.insert(publishAttempts).values({ id: id("att"), publishJobId: idv, attemptNumber, requestSnapshot: JSON.stringify(j.payloadSnapshot), errorCode: err.code, errorMessage: err.message, createdAt: now() }); await db.update(publishJobs).set({ status: err.retryable && attemptNumber < max ? PublishJobStatus.RetryPending : PublishJobStatus.Failed, attemptCount: attemptNumber, lastError: err.message, updatedAt: now() }).where(eq(publishJobs.id, idv)); } const { job: updated, attempts } = await getPublishJob(db, idv); return { job: updated, attempts }; }
export async function endExternalListing(db: DbClient, productId: string, listingId: string, adapter?: MarketplaceAdapter) { const [l] = await db.select().from(externalListings).where(and(eq(externalListings.productId, productId), eq(externalListings.id, listingId))); if (!l) throw new NotFoundError("External listing not found"); const c = await active(db, l.channel as PublishChannel); const result = await getAdapter(l.channel as PublishChannel, adapter).endListing(decryptCredential(c.encryptedAccessToken!), l.externalListingId); await db.update(externalListings).set({ externalStatus: result.externalStatus, updatedAt: now() }).where(eq(externalListings.id, l.id)); return { ok: true, externalListingId: l.externalListingId, status: result.externalStatus }; }
