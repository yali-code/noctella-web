import * as sqliteSchema from "../../../db/schema.sqlite"; import { createInventoryRepositories } from "../drizzleCore";
export const createSqliteInventoryRepositories=(db:unknown,execution:"synchronous"|"asynchronous"="asynchronous")=>createInventoryRepositories(db,sqliteSchema,execution);
