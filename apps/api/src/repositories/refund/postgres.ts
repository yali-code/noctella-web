import * as schema from "../../db/schema.postgres";
import { createSqliteRefundRepositories as create } from "./sqlite";
import type { RefundRepositories } from "./types";
export function createPostgresRefundRepositories(db:unknown):RefundRepositories{return create(db as any, schema as any) as RefundRepositories;}
