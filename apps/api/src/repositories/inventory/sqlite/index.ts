import * as sqliteSchema from "../../../db/schema.sqlite"; import { createInventoryRepositories } from "../drizzleCore";
export const createSqliteInventoryRepositories=(db:unknown)=>createInventoryRepositories(db,sqliteSchema);
