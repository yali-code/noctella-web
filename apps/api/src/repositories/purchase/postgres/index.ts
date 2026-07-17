import * as sqliteSchema from "../../../db/schema.sqlite"; import { createSqlitePurchaseRepositories } from "../sqlite"; import type { PurchaseRepositories } from "../types";
export function createPostgresPurchaseRepositories(db:unknown):PurchaseRepositories{return createSqlitePurchaseRepositories(db as any, sqliteSchema as any);}
