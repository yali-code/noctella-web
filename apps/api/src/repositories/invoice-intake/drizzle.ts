import { and, desc, eq, inArray, sql } from "drizzle-orm";
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
} from "./types";

type Schema = typeof sqliteSchema | typeof postgresSchema;

const costSetTimestampFields = ["createdAt", "updatedAt", "approvedAt"] as const;
const intakeTimestampFields = ["createdAt", "updatedAt"] as const;
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
  };
}
