import { eq, inArray } from "drizzle-orm";
import { photoTimestampValues } from "../photoTimestamps";
import * as sqliteSchema from "../../db/schema.sqlite";
import * as postgresSchema from "../../db/schema.postgres";
import type { EbayStatementRepository, EbayStatementRowRecord } from "./types";

const MONEY = ["itemSubtotalUsd", "shippingUsd", "ebayTaxUsd", "feesUsd", "grossUsd", "netEur", "exchangeRate"] as const;
const LOOKUP_CHUNK = 400;

function createDrizzleEbayStatementRepository(db: any, schema: typeof sqliteSchema | typeof postgresSchema, dateMode: boolean): EbayStatementRepository {
  const rows = schema.ebayStatementRows as any, imports = schema.ebayStatementImports as any;
  const stamped = (values: Record<string, unknown>) => photoTimestampValues(values, ["createdAt", "updatedAt"], dateMode);
  const encode = (row: EbayStatementRowRecord): Record<string, unknown> => {
    const copy: Record<string, unknown> = { ...row };
    if (dateMode) for (const key of MONEY) if (copy[key] != null) copy[key] = String(copy[key]);
    return copy;
  };
  const record = (row: any): EbayStatementRowRecord => {
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = row;
    for (const key of MONEY) if (rest[key] != null) rest[key] = Number(rest[key]);
    return rest;
  };
  return {
    async findRowsByIds(ids) {
      const found: EbayStatementRowRecord[] = [];
      for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) found.push(...((await db.select().from(rows).where(inArray(rows.id, ids.slice(i, i + LOOKUP_CHUNK)))) as any[]).map(record));
      return found;
    },
    async insertRow(row, now) {
      await db.insert(rows).values(stamped({ ...encode(row), createdAt: now, updatedAt: now }));
    },
    async updateRow(row, now) {
      await db.update(rows).set(stamped({ ...encode(row), updatedAt: now })).where(eq(rows.id, row.id));
    },
    async insertImport(item, now) {
      await db.insert(imports).values(stamped({ ...item, createdAt: now }));
    },
    async listRows() {
      return ((await db.select().from(rows)) as any[]).map(record);
    },
  };
}

export function createEbayStatementRepository(driver?: string, db?: any): EbayStatementRepository {
  if (!driver || !db) {
    const { dbRuntime } = require("../../db/client") as typeof import("../../db/client");
    driver ??= dbRuntime.driver;
    db ??= dbRuntime.db;
  }
  if (!db) throw new Error("eBay statement repository requires a database client");
  if (driver === "sqlite" || driver === "test-memory") return createDrizzleEbayStatementRepository(db, sqliteSchema, false);
  if (driver === "postgres" || driver === "supabase-postgres") return createDrizzleEbayStatementRepository(db, postgresSchema, true);
  throw new Error(`Unsupported eBay statement repository driver: ${driver}`);
}
