import * as sqlite from "../../db/schema.sqlite";
import * as postgres from "../../db/schema.postgres";
import { getDatabaseConfig } from "../../db/config";

export function productLifecycleSchema() {
  return (getDatabaseConfig().driver === "sqlite" ? sqlite : postgres) as typeof sqlite | typeof postgres;
}
