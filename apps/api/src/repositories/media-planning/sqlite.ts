import { and, asc, desc, eq, inArray } from "drizzle-orm";
import * as schema from "../../db/schema.sqlite";
import type { PlannerProductRow } from "../../use-cases/media-planning/planner";

/**
 * Media Planning Agent persistence (SQLite, synchronous). Reads products/photos read-only; writes
 * only media_plans / media_plan_items. Optimistic versioning on items; status transitions are
 * conditional on the expected current status.
 */
export function createMediaPlanRepository(db: any) {
  const plans = schema.mediaPlans, items = schema.mediaPlanItems;
  return Object.freeze({
    readPlannerProducts(): PlannerProductRow[] {
      const rows = db.select({ p: schema.products, category: schema.categories.name }).from(schema.products).leftJoin(schema.categories, eq(schema.categories.id, schema.products.categoryId)).all() as any[];
      if (!rows.length) return [];
      const photos = db.select().from(schema.productPhotos).where(inArray(schema.productPhotos.productId, rows.map((r) => r.p.id))).all() as any[];
      return rows.map(({ p, category }) => ({
        id: p.id, sku: p.sku, title: p.title, status: p.status, stockQuantity: p.stockQuantity, salePausedAt: p.salePausedAt ?? null,
        category: category ?? null, brand: p.brand ?? null, condition: p.condition ?? null, createdAt: p.createdAt,
        photos: photos.filter((ph) => ph.productId === p.id).map((ph) => ({ id: ph.id, url: ph.url, isPrimary: Boolean(ph.isPrimary), sortOrder: ph.sortOrder ?? 0, processingStatus: ph.processingStatus ?? null })),
      }));
    },
    insertPlan(plan: typeof plans.$inferInsert, planItems: (typeof items.$inferInsert)[]) {
      db.transaction((tx: any) => {
        tx.insert(plans).values(plan).run();
        for (const item of planItems) tx.insert(items).values(item).run();
      });
    },
    getPlan(id: string) { return db.select().from(plans).where(eq(plans.id, id)).get() ?? null; },
    latestPlan() { return db.select().from(plans).orderBy(desc(plans.generatedAt), desc(plans.id)).limit(1).get() ?? null; },
    listItems(planId: string) { return db.select().from(items).where(eq(items.planId, planId)).orderBy(asc(items.itemIndex)).all() as any[]; },
    getItem(planId: string, itemId: string) { return db.select().from(items).where(and(eq(items.planId, planId), eq(items.id, itemId))).get() ?? null; },
    /** Conditional transition: only from one of `from`. */
    setPlanStatus(id: string, from: readonly string[], set: Partial<typeof plans.$inferInsert>): boolean {
      return db.update(plans).set(set).where(and(eq(plans.id, id), inArray(plans.status, [...from]))).run().changes === 1;
    },
    /** Owner edit with optimistic version check. */
    editItem(id: string, version: number, set: Partial<typeof items.$inferInsert>): boolean {
      return db.update(items).set({ ...set, version: version + 1 }).where(and(eq(items.id, id), eq(items.version, version))).run().changes === 1;
    },
    /** System bookkeeping (render result / social-chain linkage) - no owner-visible version bump. */
    patchItem(id: string, set: Partial<typeof items.$inferInsert>) { db.update(items).set(set).where(eq(items.id, id)).run(); },
    findSocialContentByConcept(concept: string): string | null {
      return (db.select({ id: schema.socialContents.id }).from(schema.socialContents).where(eq(schema.socialContents.concept, concept)).get() as any)?.id ?? null;
    },
    findApprovalByRequestId(requestId: string): string | null {
      return (db.select({ id: schema.socialContentApprovals.id }).from(schema.socialContentApprovals).where(eq(schema.socialContentApprovals.requestId, requestId)).get() as any)?.id ?? null;
    },
  });
}
