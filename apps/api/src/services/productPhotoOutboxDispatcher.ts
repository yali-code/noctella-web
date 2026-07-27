import type { DbClient } from "../db/client";
import { createProductWriteRepositoryBundleForDb } from "../repositories/product-write/factory";
import { productPhotoStaticPath, productPhotoStaticRoot } from "./photoStorage";
import { OutboxDispatcher } from "./outbox";
import { PostgresOutboxRepository, SqliteOutboxRepository } from "./outboxRepository";
import {
  ProductPhotoCleanupTempHandler,
  ProductPhotoDeleteHandler,
  ProductPhotoPromotionHandler,
  type ProductPhotoStorageRoots,
} from "./productPhotoStorageWorkflow";
import { PostgresUnitOfWork, type UnitOfWork } from "./unitOfWork";

export type ProductPhotoOutboxDriver = "sqlite" | "postgres" | "supabase-postgres";

/**
 * Sprint 71: ProductPhotoPromotionHandler's writes (storage metadata, processingStatus) are
 * individually idempotent blind UPDATEs by photo id, safe to reapply on retry - unlike the
 * order/purchase workflows they do not need SqliteUnitOfWork's real, synchronous better-sqlite3
 * transaction. That matters because the handler's callback uses `await` internally and therefore
 * always returns a Promise; SqliteUnitOfWork.run() rejects any Promise-returning callback
 * (better-sqlite3 transactions must never return Promises), so wiring the real SqliteUnitOfWork
 * here would make every promotion attempt throw. This pass-through runs the callback directly,
 * outside of a real sqlite transaction.
 */
function unitOfWorkForPromotion(db: DbClient, driver: ProductPhotoOutboxDriver): UnitOfWork {
  if (driver === "postgres" || driver === "supabase-postgres") return new PostgresUnitOfWork(db as never);
  return {
    run: (work) =>
      Promise.resolve(
        work({ repositories: { db, productWrite: createProductWriteRepositoryBundleForDb(db, "sqlite") } as any }),
      ),
  };
}

/**
 * LocalPhotoStorage (the only storage backend implemented today) writes uploads directly into
 * the single directory Express serves publicly - there is no separate temp stage. tempRoot and
 * permanentRoot are therefore deliberately the same directory; ProductPhotoPromotionHandler
 * detects that and only verifies the files exist before marking Ready, never copying/deleting.
 */
function defaultRoots(): ProductPhotoStorageRoots {
  return { tempRoot: productPhotoStaticRoot, permanentRoot: productPhotoStaticRoot, publicBase: productPhotoStaticPath };
}

export function createProductPhotoOutboxDispatcher(
  db: DbClient,
  driver: ProductPhotoOutboxDriver = (process.env.DATABASE_DRIVER as ProductPhotoOutboxDriver) || "sqlite",
  roots: ProductPhotoStorageRoots = defaultRoots(),
): OutboxDispatcher {
  const isPostgres = driver === "postgres" || driver === "supabase-postgres";
  const repo = isPostgres
    ? new PostgresOutboxRepository((db as unknown as { $client: ConstructorParameters<typeof PostgresOutboxRepository>[0] }).$client)
    : new SqliteOutboxRepository((db as unknown as { $client: ConstructorParameters<typeof SqliteOutboxRepository>[0] }).$client);
  const dispatcher = new OutboxDispatcher(repo);
  dispatcher.registerHandler(new ProductPhotoPromotionHandler(unitOfWorkForPromotion(db, driver), roots));
  dispatcher.registerHandler(new ProductPhotoDeleteHandler(roots));
  dispatcher.registerHandler(new ProductPhotoCleanupTempHandler(roots));
  return dispatcher;
}

/**
 * An outbox event left in Processing by an abrupt crash (kill -9, power loss - not the graceful
 * SIGTERM/SIGINT path in serverLifecycle.ts, which drains in-flight requests before shutting
 * down) would otherwise never be reclaimed: claimNextBatch only selects Pending/RetryPending.
 * Five minutes is far longer than any real promotion/delete/cleanup handler run (simple fs
 * stat/copy/unlink calls, completing well within one HTTP request) and far shorter than the
 * hourly scheduler cadence (render.yaml), so a stuck event recovers on the very next run without
 * ever mistaking a lock still legitimately in use for stale.
 */
export const PRODUCT_PHOTO_OUTBOX_STALE_LOCK_MS = 5 * 60 * 1000;

export async function dispatchDueProductPhotoOutboxEvents(db: DbClient, workerId = "scheduler", limit = 10) {
  const dispatcher = createProductPhotoOutboxDispatcher(db);
  await dispatcher.releaseStaleLocks(PRODUCT_PHOTO_OUTBOX_STALE_LOCK_MS);
  return dispatcher.dispatchDueEvents(workerId, limit);
}
