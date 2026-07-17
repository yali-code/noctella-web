import * as postgresSchema from "../../../db/schema.postgres"; import { createInventoryRepositories } from "../drizzleCore";
export const createPostgresInventoryRepositories=(db:unknown)=>createInventoryRepositories(db,postgresSchema);
