import { and, desc, eq, ilike, inArray, isNotNull, like, ne, notExists, or, sql } from "drizzle-orm";
import { photoTimestampRecord, photoTimestampValues } from "../photoTimestamps";
import type * as sqliteSchema from "../../db/schema.sqlite";
import type * as postgresSchema from "../../db/schema.postgres";
import {
  DuplicateInvoiceFileError,
  type ExpectedStatusTransitionInput,
  type ExpectedStatusTransitionResult,
  type InvoiceCostSetCreateInput,
  type InvoiceCostSetListQuery,
  type InvoiceCostSetRecord,
  type InvoiceIntakeCreateInput,
  type InvoiceIntakeRecord,
  type InvoiceIntakeRepository,
  type InvoiceIntakeReviewUpdateInput,
  type InvoiceIntakeFxUpdateInput,
  type InvoiceCostSetApproveInput,
  type InvoiceCostSetItemAllocationInput,
  type InvoiceCostSetItemInput,
  type InvoiceCostSetItemRecord,
  type CostSetProductFacts,
} from "./types";

type Schema = typeof sqliteSchema | typeof postgresSchema;

const costSetTimestampFields = ["createdAt", "updatedAt", "approvedAt"] as const;
const intakeTimestampFields = ["createdAt", "updatedAt"] as const;
const itemTimestampFields = ["createdAt", "updatedAt"] as const;
const itemMoneyFields = ["valueWeightEur", "allocLotEur", "allocHammerFeeEur", "allocPremiumEur", "allocTransportEur", "allocForwarderEur", "allocFxDiffEur", "allocTotalEur"] as const;
/** PHASE-2C: a cancelled purchase does not hold a product's cost of record; open and approved sets hold their products. */
const CANCELLED_PURCHASE_STATUS = "Cancelled";
const BLOCKING_SET_STATUSES = ["open", "approved"];
const toNumber = (v: unknown) => (v == null ? null : Number(v));
const toIso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
/** numeric(18,6) comes back from PostgreSQL as a string; expose numbers on both drivers. */
const intakeMoneyFields = ["totalOriginal", "fxRate", "bankDebitEur"] as const;

function isUniqueViolation(error: unknown): boolean {
  for (let e: any = error; e; e = e.cause) {
    if (e.code === "23505" || e.code === "SQLITE_CONSTRAINT_UNIQUE" || String(e.message ?? "").includes("UNIQUE constraint failed")) return true;
  }
  return false;
}

export function createDrizzleInvoiceIntakeRepository(db: any, schema: Schema): InvoiceIntakeRepository {
  const sets = (schema as Record<string, any>).invoiceCostSets;
  const intakes = (schema as Record<string, any>).invoiceIntakes;
  const dateMode = sets.createdAt.dataType === "date";
  const setValues = (values: Record<string, unknown>) => photoTimestampValues(values, costSetTimestampFields, dateMode);
  const intakeValues = (values: Record<string, unknown>) => photoTimestampValues(values, intakeTimestampFields, dateMode);
  const setRecord = (row: any) => photoTimestampRecord(row, costSetTimestampFields) as InvoiceCostSetRecord;
  const intakeRecord = (row: any) => {
    const out = photoTimestampRecord(row, intakeTimestampFields) as InvoiceIntakeRecord;
    if (out) for (const field of intakeMoneyFields) if (typeof out[field] === "string") out[field] = Number(out[field]);
    return out;
  };
  const items = (schema as Record<string, any>).invoiceCostSetItems;
  const { products, aiProductIntakes, aiIntakeProposals, purchases, purchaseLines } = schema as Record<string, any>;
  const itemValues = (values: Record<string, unknown>) => photoTimestampValues(values, itemTimestampFields, dateMode);
  const itemRecord = (row: any) => {
    const out = photoTimestampRecord(row, itemTimestampFields) as InvoiceCostSetItemRecord;
    for (const field of itemMoneyFields) if (typeof out[field] === "string") out[field] = Number(out[field]);
    return out;
  };
  const contains = (col: any, value: string) => (dateMode ? ilike(col, `%${value}%`) : like(sql`lower(${col})`, `%${value.toLowerCase()}%`));

  /** Runs statement builders in one transaction: synchronous for better-sqlite3 (never a Promise), awaited for PostgreSQL. */
  async function inTransaction(statements: Array<(tx: any) => any>) {
    if (!dateMode) {
      db.transaction((tx: any) => { for (const build of statements) build(tx).run(); });
      return;
    }
    await db.transaction(async (tx: any) => { for (const build of statements) await build(tx); });
  }

  /** A non-cancelled purchase other than the set's own (identified by its ERP reference). */
  const livePurchaseNotOwn = (ownPurchaseReference: string) => and(
    ne(purchases.status, CANCELLED_PURCHASE_STATUS),
    or(sql`${purchases.erpReferenceId} IS NULL`, ne(purchases.erpReferenceId, ownPurchaseReference)),
  );
  const onLivePurchase = (ownPurchaseReference: string) => db
    .select({ id: purchaseLines.id })
    .from(purchaseLines)
    .innerJoin(purchases, eq(purchases.id, purchaseLines.purchaseId))
    .where(and(eq(purchaseLines.productId, products.id), livePurchaseNotOwn(ownPurchaseReference)));
  const inOtherSet = (costSetId: string) => db
    .select({ id: items.id })
    .from(items)
    .innerJoin(sets, eq(sets.id, items.costSetId))
    .where(and(eq(items.productId, products.id), ne(items.costSetId, costSetId), inArray(sets.status, BLOCKING_SET_STATUSES)));

  const productFactColumns = () => ({
    productId: products.id, sku: products.sku, title: products.title, createdAt: products.createdAt, purchaseCost: products.purchaseCost,
    aiSuggestedPriceEur: aiIntakeProposals.suggestedPriceEur, aiIntakeId: aiProductIntakes.id,
  });
  const productFacts = (row: any): CostSetProductFacts => ({
    productId: row.productId, sku: row.sku, title: row.title, createdAt: toIso(row.createdAt), purchaseCost: toNumber(row.purchaseCost),
    aiSuggestedPriceEur: toNumber(row.aiSuggestedPriceEur), fromAiIntake: row.aiIntakeId != null,
  });

  const statusFilter = (query: InvoiceCostSetListQuery) => (query.status ? eq(sets.status, query.status) : undefined);

  async function transition<T>(table: any, record: (row: any) => T, values: (v: Record<string, unknown>) => Record<string, unknown>, label: string, input: ExpectedStatusTransitionInput, extra: Record<string, unknown> = {}): Promise<ExpectedStatusTransitionResult<T>> {
    const changed = await db
      .update(table)
      .set(values({ ...extra, status: input.nextStatus, updatedAt: input.updatedAt }))
      .where(and(eq(table.id, input.id), inArray(table.status, input.expectedStatuses as string[])))
      .returning();
    if (changed.length) return { updated: true, row: record(changed[0]) };
    const [existing] = await db.select().from(table).where(eq(table.id, input.id));
    if (!existing) return { updated: false, conflict: { field: "id", message: `${label} not found` } };
    return { updated: false, row: record(existing), conflict: { field: "status", message: `${label} cannot change from status "${existing.status}"` } };
  }

  return {
    async createCostSet(input: InvoiceCostSetCreateInput) {
      await db.insert(sets).values(setValues({ ...input, status: "open" }));
      const [row] = await db.select().from(sets).where(eq(sets.id, input.id));
      return setRecord(row);
    },

    async findCostSetById(id: string) {
      const [row] = await db.select().from(sets).where(eq(sets.id, id));
      return row ? setRecord(row) : null;
    },

    async listCostSets(query: InvoiceCostSetListQuery) {
      const rows = await db.select().from(sets).where(statusFilter(query)).orderBy(desc(sets.createdAt), desc(sets.id))
        .limit(query.pageSize).offset((query.page - 1) * query.pageSize);
      return rows.map(setRecord);
    },

    async countCostSets(query: InvoiceCostSetListQuery) {
      const [{ total }] = await db.select({ total: sql<number>`count(*)` }).from(sets).where(statusFilter(query));
      return Number(total);
    },

    transitionCostSet: (input: ExpectedStatusTransitionInput) => transition(sets, setRecord, setValues, "Invoice cost set", input),

    async createIntake(input: InvoiceIntakeCreateInput) {
      try {
        await db.insert(intakes).values(intakeValues({ ...input, status: "uploaded" }));
      } catch (error) {
        if (isUniqueViolation(error)) throw new DuplicateInvoiceFileError();
        throw error;
      }
      const [row] = await db.select().from(intakes).where(eq(intakes.id, input.id));
      return intakeRecord(row);
    },

    async findIntakeById(id: string) {
      const [row] = await db.select().from(intakes).where(eq(intakes.id, id));
      return row ? intakeRecord(row) : null;
    },

    async findIntakeBySha256(costSetId: string, sha256: string) {
      const [row] = await db.select().from(intakes).where(and(eq(intakes.costSetId, costSetId), eq(intakes.fileSha256, sha256)));
      return row ? intakeRecord(row) : null;
    },

    async listIntakesByCostSet(costSetId: string) {
      const rows = await db.select().from(intakes).where(eq(intakes.costSetId, costSetId)).orderBy(intakes.createdAt, intakes.id);
      return rows.map(intakeRecord);
    },

    transitionIntake: (input: ExpectedStatusTransitionInput) => transition(intakes, intakeRecord, intakeValues, "Invoice intake", input),

    updateIntakeReview: (input: InvoiceIntakeReviewUpdateInput) => transition(intakes, intakeRecord, intakeValues, "Invoice intake", input, { ...input.values }),

    updateIntakeFx: (input: InvoiceIntakeFxUpdateInput) => transition(intakes, intakeRecord, intakeValues, "Invoice intake", input, { ...input.values }),

    async listCostSetItems(costSetId: string) {
      const rows = await db.select().from(items).where(eq(items.costSetId, costSetId)).orderBy(items.createdAt, items.id);
      return rows.map(itemRecord);
    },

    async replaceCostSetItems(costSetId: string, rows: InvoiceCostSetItemInput[], updatedAt: string) {
      const base = Date.parse(updatedAt);
      await inTransaction([
        (tx) => tx.delete(items).where(eq(items.costSetId, costSetId)),
        // created_at is offset per row so the admin's selection order is kept when read back.
        ...rows.map((row, index) => (tx: any) => tx.insert(items).values(itemValues({ ...row, costSetId, createdAt: new Date(base + index).toISOString(), updatedAt }))),
      ]);
    },

    async saveCostSetItemAllocations(costSetId: string, rows: InvoiceCostSetItemAllocationInput[], updatedAt: string) {
      await inTransaction(rows.map(({ productId, ...alloc }) => (tx: any) => tx.update(items)
        .set(itemValues({ ...alloc, updatedAt }))
        .where(and(eq(items.costSetId, costSetId), eq(items.productId, productId)))));
    },

    async saveCostSetItemWeights(costSetId: string, rows: Array<Omit<InvoiceCostSetItemInput, "id">>, updatedAt: string) {
      await inTransaction(rows.map(({ productId, ...weight }) => (tx: any) => tx.update(items)
        .set(itemValues({ ...weight, updatedAt }))
        .where(and(eq(items.costSetId, costSetId), eq(items.productId, productId)))));
    },

    async findProductFacts(productIds: string[]) {
      if (!productIds.length) return [];
      const rows = await db.select(productFactColumns()).from(products)
        .leftJoin(aiProductIntakes, eq(aiProductIntakes.resultProductId, products.id))
        .leftJoin(aiIntakeProposals, eq(aiIntakeProposals.intakeId, aiProductIntakes.id))
        .where(inArray(products.id, productIds));
      return rows.map(productFacts);
    },

    async findProductConflicts({ costSetId, productIds, ownPurchaseReference }) {
      if (!productIds.length) return { onPurchase: [], inOtherSet: [] };
      const onPurchase = await db.selectDistinct({ productId: purchaseLines.productId }).from(purchaseLines)
        .innerJoin(purchases, eq(purchases.id, purchaseLines.purchaseId))
        .where(and(inArray(purchaseLines.productId, productIds), livePurchaseNotOwn(ownPurchaseReference)));
      const otherSet = await db.selectDistinct({ productId: items.productId }).from(items)
        .innerJoin(sets, eq(sets.id, items.costSetId))
        .where(and(inArray(items.productId, productIds), ne(items.costSetId, costSetId), inArray(sets.status, BLOCKING_SET_STATUSES)));
      return { onPurchase: onPurchase.map((r: any) => r.productId), inOtherSet: otherSet.map((r: any) => r.productId) };
    },

    async listProductCandidates({ costSetId, query, limit, ownPurchaseReference }) {
      const term = query.trim().replace(/[%_\\]/g, "");
      const filters: any[] = [isNotNull(aiProductIntakes.resultProductId), notExists(onLivePurchase(ownPurchaseReference)), notExists(inOtherSet(costSetId))];
      if (term) filters.push(or(contains(products.sku, term), contains(products.title, term)));
      const rows = await db.select(productFactColumns()).from(products)
        .innerJoin(aiProductIntakes, eq(aiProductIntakes.resultProductId, products.id))
        .leftJoin(aiIntakeProposals, eq(aiIntakeProposals.intakeId, aiProductIntakes.id))
        .where(and(...filters))
        .orderBy(desc(products.createdAt), desc(products.id))
        .limit(limit);
      return rows.map(productFacts);
    },

    async findPurchaseByErpReference(erpReferenceId: string) {
      const [purchase] = await db.select({ id: purchases.id, status: purchases.status }).from(purchases).where(eq(purchases.erpReferenceId, erpReferenceId)).limit(1);
      if (!purchase) return null;
      const lines = await db.select({ productId: purchaseLines.productId, quantity: purchaseLines.quantity, unitPurchaseCost: purchaseLines.unitPurchaseCost })
        .from(purchaseLines).where(eq(purchaseLines.purchaseId, purchase.id));
      return { id: purchase.id, status: purchase.status, lines: lines.map((l: any) => ({ productId: l.productId ?? null, quantity: Number(l.quantity), unitPurchaseCost: Number(l.unitPurchaseCost) })) };
    },

    approveCostSet: (input: InvoiceCostSetApproveInput) => transition(sets, setRecord, setValues, "Invoice cost set",
      { id: input.id, expectedStatuses: ["open"], nextStatus: "approved", updatedAt: input.updatedAt },
      { purchaseId: input.purchaseId, approvedBy: input.approvedBy, approvedAt: input.approvedAt }),
  };
}
