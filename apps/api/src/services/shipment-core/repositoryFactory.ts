import { createSqliteShipmentRepositories } from "./sqliteShipmentRepository";
import { createPostgresShipmentRepositories } from "./postgresShipmentRepository";
export type ShipmentRepositoryDriver = "sqlite" | "postgres" | "supabase-postgres" | "test-memory";
export function createShipmentRepositories(driver: ShipmentRepositoryDriver, client: any, injected?: any) {
  if (driver === "test-memory") { if (!injected) throw new Error("test-memory Shipment repository requires injected implementation"); return injected; }
  if (!client) throw new Error(`Shipment repository client is required for ${driver}`);
  if (driver === "sqlite") return createSqliteShipmentRepositories(client);
  if (driver === "postgres" || driver === "supabase-postgres") return createPostgresShipmentRepositories(client);
  throw new Error(`Unsupported Shipment repository driver: ${driver}`);
}
