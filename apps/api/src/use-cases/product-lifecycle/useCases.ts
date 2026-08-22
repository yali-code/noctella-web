import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ProductStatus, PublishChannel, type ProductLifecycleOperation, type ProductLifecycleResult, type ProductLifecycleTarget } from "@noctella/shared";
import type { DbClient } from "../../db/client";
import { getDatabaseConfig } from "../../db/config";
import { mapProductLifecycleOperation } from "../../repositories/product-lifecycle/drizzle";
import { createProductLifecycleRepository } from "../../repositories/product-lifecycle/factory";
import { productLifecycleSchema } from "../../repositories/product-lifecycle/schema";
import { ConflictError, NotFoundError } from "../../services/errors";

export const TERMINAL_EXTERNAL_LISTING_STATUSES = new Set(["ended", "inactive", "sold", "closed"]);
export const isTerminalExternalListingStatus = (status: string) => TERMINAL_EXTERNAL_LISTING_STATUSES.has(String(status ?? "").toLowerCase());
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : String(value);
const nextUpdatedAt = (value: unknown) => new Date(Math.max(Date.now(), Date.parse(iso(value)) + 1)).toISOString();
const ineligible = new Set<ProductStatus>([ProductStatus.Sold, ProductStatus.Archived, ProductStatus.Returned]);

export interface BeginProductPauseInput { productId: string; actorAdminUserId: string; idempotencyKey: string; reason?: string }
export interface BeginProductPauseResult extends ProductLifecycleResult { operation: ProductLifecycleOperation }

function targetsFor(product: any, listings: any[]): ProductLifecycleTarget[] {
  const targets: ProductLifecycleTarget[] = product.status === ProductStatus.Published ? [{ key: "local:noctella_web", kind: "local", channel: PublishChannel.NoctellaWeb, status: "succeeded" }] : [];
  for (const listing of listings) if ([PublishChannel.Ebay, PublishChannel.Etsy].includes(listing.channel) && !isTerminalExternalListingStatus(listing.externalStatus)) targets.push({ key: `external:${listing.id}`, kind: "external", channel: listing.channel, internalListingId: listing.id, externalListingId: listing.externalListingId, connectionId: listing.connectionId, previousExternalStatus: listing.externalStatus, status: "pending" });
  return targets.sort((a, b) => `${a.channel}:${a.key}`.localeCompare(`${b.channel}:${b.key}`));
}

export async function beginProductPause(db: DbClient, input: BeginProductPauseInput): Promise<BeginProductPauseResult> {
  const replay = await createProductLifecycleRepository(db).getByIdempotencyKey(input.idempotencyKey);
  if (replay) { if (replay.productId !== input.productId || replay.action !== "pause") throw new ConflictError("Lifecycle idempotency key is already in use"); const { products } = productLifecycleSchema() as any; const [product] = await (db as any).select().from(products).where(eq(products.id, input.productId)); const version = iso(product.updatedAt); return { operation: replay, productUpdatedAtBefore: version, productUpdatedAtAfter: version }; }
  const schema = productLifecycleSchema() as any; const { products, externalListings, productLifecycleOperations } = schema; const driver = getDatabaseConfig().driver;
  const build = (product: any, listings: any[]) => {
    if (!product) throw new NotFoundError("Product not found"); if (ineligible.has(product.status)) throw new ConflictError("Product lifecycle does not allow Pause");
    const targets = targetsFor(product, listings), before = iso(product.updatedAt), after = nextUpdatedAt(product.updatedAt), now = new Date().toISOString();
    if (!targets.length && !product.salePausedAt) throw new ConflictError("Product has no active sales channel to pause");
    const operation = { id: `lifecycle_${crypto.randomUUID()}`, productId: input.productId, action: "pause", status: targets.some((target) => target.kind === "external") ? "processing" : "succeeded", reason: input.reason, previousProductStatus: product.status, targetSnapshot: targets, targetResults: targets, actorAdminUserId: input.actorAdminUserId, idempotencyKey: input.idempotencyKey, createdAt: now, updatedAt: now, completedAt: targets.some((target) => target.kind === "external") ? null : now };
    return { operation, before, after, now };
  };
  let result!: { operation: any; before: string; after: string; now: string };
  if (driver === "sqlite") {
    (db as any).transaction((tx: any) => { const product = tx.select().from(products).where(eq(products.id, input.productId)).get(); const listings = tx.select().from(externalListings).where(eq(externalListings.productId, input.productId)).all(); result = build(product, listings); const changed = tx.update(products).set({ salePausedAt: product.salePausedAt ?? result.now, updatedAt: result.after }).where(and(eq(products.id, input.productId), eq(products.updatedAt, product.updatedAt))).run(); if (changed.changes !== 1) throw new ConflictError("Product changed while Pause was being established"); tx.insert(productLifecycleOperations).values({ ...result.operation, targetSnapshot: JSON.stringify(result.operation.targetSnapshot), targetResults: JSON.stringify(result.operation.targetResults) }).run(); });
  } else {
    result = await (db as any).transaction(async (tx: any) => { const [product] = await tx.select().from(products).where(eq(products.id, input.productId)); const listings = await tx.select().from(externalListings).where(eq(externalListings.productId, input.productId)); const built = build(product, listings); const changed = await tx.update(products).set({ salePausedAt: product.salePausedAt ?? new Date(built.now), updatedAt: new Date(built.after) }).where(and(eq(products.id, input.productId), eq(products.updatedAt, product.updatedAt))).returning({ id: products.id }); if (changed.length !== 1) throw new ConflictError("Product changed while Pause was being established"); await tx.insert(productLifecycleOperations).values({ ...built.operation, targetSnapshot: built.operation.targetSnapshot, targetResults: built.operation.targetResults, createdAt: new Date(built.now), updatedAt: new Date(built.now), completedAt: built.operation.completedAt ? new Date(built.operation.completedAt) : null }); return built; });
  }
  return { operation: mapProductLifecycleOperation(result.operation), productUpdatedAtBefore: result.before, productUpdatedAtAfter: result.after };
}
