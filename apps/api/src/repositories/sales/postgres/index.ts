import * as sqliteSchema from "../../../db/schema.sqlite"; import { createSqliteSalesRepositories } from "../sqlite"; import type { SalesRepositories } from "../types";
export function createPostgresSalesRepositories(db:unknown):SalesRepositories{return createSqliteSalesRepositories(db as any, sqliteSchema as any)}
