import { asc, eq } from "drizzle-orm";
import * as sqliteSchema from "../../db/schema.sqlite";
import * as postgresSchema from "../../db/schema.postgres";
import type { CreateShippingMethodInput, ShippingMethodRecord, ShippingMethodRepository, UpdateShippingMethodInput } from "./types";

// Sprint 134: same dual sync(sqlite)/async(postgres) execution idiom already proven in
// repositories/payment/drizzle.ts - reused unchanged rather than reinvented.
type Execution = "synchronous" | "asynchronous";
type Result<T> = T | Promise<T>;
const then = <T, U>(value: Result<T>, next: (item: T) => Result<U>): Result<U> => (value instanceof Promise ? value.then(next) : next(value));
const rows = (query: any, execution: Execution): Result<any[]> => (execution === "synchronous" ? (Array.isArray(query) ? query : query.all()) : Promise.resolve(query).then((value: any) => (Array.isArray(value) ? value : value.all())));
const execute = (query: any, execution: Execution): Result<any> => (execution === "synchronous" ? query.run() : Promise.resolve(query));

const record = (row: any): ShippingMethodRecord => ({
  id: row.id,
  label: row.label,
  isActive: Boolean(row.isActive),
  sortOrder: Number(row.sortOrder),
  ruleType: row.ruleType,
  flatAmountEurCents: row.flatAmountEurCents == null ? null : Number(row.flatAmountEurCents),
  freeThresholdEurCents: row.freeThresholdEurCents == null ? null : Number(row.freeThresholdEurCents),
  countryCodes: row.countryCodes ? JSON.parse(row.countryCodes) : null,
  shippingProfiles: row.shippingProfiles ? JSON.parse(row.shippingProfiles) : null,
  createdAt: String(row.createdAt),
  updatedAt: String(row.updatedAt),
});

function toRow(input: any) {
  const row: Record<string, unknown> = { ...input };
  if ("countryCodes" in input) row.countryCodes = input.countryCodes ? JSON.stringify(input.countryCodes) : null;
  if ("shippingProfiles" in input) row.shippingProfiles = input.shippingProfiles ? JSON.stringify(input.shippingProfiles) : null;
  return row;
}

export function createShippingMethodRepository(db: any, driver: "sqlite" | "postgres"): ShippingMethodRepository {
  const schema: any = driver === "sqlite" ? sqliteSchema : postgresSchema;
  const execution: Execution = driver === "sqlite" ? "synchronous" : "asynchronous";
  const { shippingMethods } = schema;
  const findById = (id: string) => then(rows(db.select().from(shippingMethods).where(eq(shippingMethods.id, id)).limit(1), execution), (result) => (result[0] ? record(result[0]) : null));

  return {
    list: () => then(rows(db.select().from(shippingMethods).orderBy(asc(shippingMethods.sortOrder), asc(shippingMethods.id)), execution), (result) => result.map(record)),
    listActive: () => then(rows(db.select().from(shippingMethods).where(eq(shippingMethods.isActive, true)).orderBy(asc(shippingMethods.sortOrder), asc(shippingMethods.id)), execution), (result) => result.map(record)),
    getById: findById,
    create: (input: CreateShippingMethodInput) => then(execute(db.insert(shippingMethods).values(toRow(input)), execution), () => record(toRow(input))),
    update: (id: string, input: UpdateShippingMethodInput) => then(execute(db.update(shippingMethods).set(toRow(input)).where(eq(shippingMethods.id, id)), execution), () => findById(id)),
  };
}
