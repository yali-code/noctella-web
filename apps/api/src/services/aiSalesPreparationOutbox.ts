import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DbClient } from "../db/client";
import { aiIntakeProposals } from "../db/schema";
import { OutboxDispatcher, OutboxEventStatus, OutboxEventType, type OutboxEvent, type OutboxHandler } from "./outbox";
import { PostgresOutboxRepository, SqliteOutboxRepository } from "./outboxRepository";
import { getProductById, updateProduct } from "./products";
import { ProductVersionConflictError } from "./errors";

type Execution = "synchronous" | "asynchronous";
type Result<T> = T | Promise<T>;

export function aiSalesPreparationIdempotencyKey(productId: string): string {
  return `ai-sales-preparation:${productId}`;
}

/**
 * Sprint 140: transactional Outbox insert - called from inside the SAME locked Stock Acceptance
 * transaction (use-cases/ai-intake-stock-acceptance/useCases.ts) that creates the canonical
 * Product/Inventory/SKU/intake-Applied provenance, using the transaction's own already-exposed
 * ctx.tx/ctx.schema/ctx.execution - mirrors services/salesInvoiceOutbox.ts's
 * enqueueSalesInvoiceDraftForPaidOrderSync exactly, extended for the SQLite/Postgres execution
 * duality Stock Acceptance's transaction capability already supports (unlike the plain-SQLite-only
 * orders.ts precedent). If this insert throws (e.g. a genuine DB error), the whole Stock
 * Acceptance transaction rolls back automatically, since it runs on the same transaction handle -
 * Product/Inventory/SKU/intake-Applied state can never commit without the durable event.
 *
 * Never awaited when execution is "synchronous" (the SQLite branch) - the insert itself is a
 * synchronous better-sqlite3 drizzle call (`.run()`), matching runWithLockedIntake's hard
 * requirement that the whole callback stay synchronous for that driver.
 */
export function enqueueAiSalesPreparationInTransaction(
  tx: any,
  schema: any,
  execution: Execution,
  input: { productId: string; intakeId: string },
): Result<void> {
  const table = (schema as Record<string, any>).outboxEvents;
  const now = new Date().toISOString();
  const values = {
    id: randomUUID(),
    eventType: OutboxEventType.AiSalesPreparationRequested,
    aggregateType: "Product",
    aggregateId: input.productId,
    idempotencyKey: aiSalesPreparationIdempotencyKey(input.productId),
    payload: JSON.stringify({ productId: input.productId, intakeId: input.intakeId }),
    status: OutboxEventStatus.Pending,
    attemptCount: 0,
    maxAttempts: 5,
    availableAt: now,
    createdAt: now,
    updatedAt: now,
  };
  if (execution === "synchronous") {
    (tx.insert(table).values(values) as unknown as { run(): void }).run();
    return undefined;
  }
  return tx.insert(table).values(values) as unknown as Promise<void>;
}

/**
 * Sprint 140: best-effort initial price population - the canonical AI price source is the
 * EXISTING AI Intake proposal's suggestedPriceEur (read via the intakeId carried in the Outbox
 * event payload), never a new provider call. Writes ONLY when the Product's canonical priceEur is
 * currently null, and only when the suggested value is a finite number strictly greater than
 * zero. Never overwrites an existing non-null price - on a version conflict (a concurrent Admin
 * edit), re-reads once for completeness and stops; never a blind retry-and-overwrite. Swallows
 * its own failures - price enrichment must never fail channel preparation or the Outbox event.
 */
async function tryInitializePriceFromAiIntake(db: DbClient, productId: string, intakeId: string | undefined): Promise<void> {
  if (!intakeId) return;
  const product = await getProductById(db, productId);
  if (product.priceEur !== null && product.priceEur !== undefined) return; // existing non-null price always wins

  const [proposal] = await db.select({ suggestedPriceEur: aiIntakeProposals.suggestedPriceEur }).from(aiIntakeProposals).where(eq(aiIntakeProposals.intakeId, intakeId)).limit(1);
  const suggested = proposal?.suggestedPriceEur as number | null | undefined;
  if (typeof suggested !== "number" || !Number.isFinite(suggested) || suggested <= 0) return; // 0/null/NaN/Infinity/negative - never a fallback

  try {
    await updateProduct(db, productId, { priceEur: suggested, expectedUpdatedAt: product.updatedAt });
  } catch (err) {
    if (err instanceof ProductVersionConflictError) {
      await getProductById(db, productId).catch(() => undefined); // re-read once, for completeness only - never retried; Admin intent always wins
      return;
    }
    throw err;
  }
}

/**
 * Runs after Stock Acceptance has committed. Only initializes the price from the existing intake
 * proposal: channel copy and marketing tags come from the single product-page AI fill.
 */
export class AiSalesPreparationHandler implements OutboxHandler {
  eventType = OutboxEventType.AiSalesPreparationRequested;
  constructor(private readonly db: DbClient) {}

  async handle(event: OutboxEvent): Promise<void> {
    const payload = event.payload as { productId?: string; intakeId?: string };
    const productId = String(payload.productId ?? event.aggregateId ?? "");
    const intakeId = payload.intakeId ? String(payload.intakeId) : undefined;
    if (!productId) throw Object.assign(new Error("AI_SALES_PREPARATION_MISSING_PRODUCT_ID"), { permanent: true });

    // The single product-page AI fill now writes channel copy and marketing tags, so no paid call runs here.
    await tryInitializePriceFromAiIntake(this.db, productId, intakeId).catch(() => undefined);
  }
}

export function createAiSalesPreparationOutboxDispatcher(db: DbClient, driver: "sqlite" | "postgres" | "supabase-postgres" = (process.env.DATABASE_DRIVER as any) || "sqlite"): OutboxDispatcher {
  const isPostgres = driver === "postgres" || driver === "supabase-postgres";
  const repo = isPostgres
    ? new PostgresOutboxRepository((db as unknown as { $client: ConstructorParameters<typeof PostgresOutboxRepository>[0] }).$client)
    : new SqliteOutboxRepository((db as unknown as { $client: ConstructorParameters<typeof SqliteOutboxRepository>[0] }).$client);
  const dispatcher = new OutboxDispatcher(repo);
  dispatcher.registerHandler(new AiSalesPreparationHandler(db));
  return dispatcher;
}

/** Same stale-lock threshold convention as the product-photo/sales-invoice dispatchers. */
export const AI_SALES_PREPARATION_OUTBOX_STALE_LOCK_MS = 5 * 60 * 1000;

/** Registered into the existing scheduler sweep (app.ts) - the recovery mechanism for any event an immediate post-commit dispatch attempt missed or failed. */
export async function dispatchDueAiSalesPreparationOutboxEvents(db: DbClient, workerId = "scheduler", limit = 10) {
  const dispatcher = createAiSalesPreparationOutboxDispatcher(db);
  await dispatcher.releaseStaleLocks(AI_SALES_PREPARATION_OUTBOX_STALE_LOCK_MS);
  return dispatcher.dispatchDueEvents(workerId, limit);
}
