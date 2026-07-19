import type {
  AsynchronousInventoryTransactionCapability,
  InventoryTransactionCapabilityFor,
  SynchronousInventoryTransactionCapability,
} from "./transactionCapabilities";

function verifyInventoryTransactionCapabilityTypes(
  sqlite: SynchronousInventoryTransactionCapability,
  postgres: AsynchronousInventoryTransactionCapability,
): void {
  sqlite.run(() => "synchronous result");

  // A better-sqlite3 managed transaction callback must not return a promise.
  // @ts-expect-error SQLite cannot await work inside its transaction callback.
  sqlite.run(async () => "asynchronous result");

  postgres.run(async () => "asynchronous result");
  postgres.run(() => "synchronous result");

  const sqliteForDriver: InventoryTransactionCapabilityFor<"sqlite"> = sqlite;
  const postgresForDriver: InventoryTransactionCapabilityFor<"postgres"> =
    postgres;

  // Driver-specific capabilities cannot be wired to the opposite driver.
  // @ts-expect-error PostgreSQL capability is not a SQLite capability.
  const invalidSqlite: InventoryTransactionCapabilityFor<"sqlite"> = postgres;
  // @ts-expect-error SQLite capability is not a PostgreSQL capability.
  const invalidPostgres: InventoryTransactionCapabilityFor<"postgres"> = sqlite;

  void sqliteForDriver;
  void postgresForDriver;
  void invalidSqlite;
  void invalidPostgres;
}

void verifyInventoryTransactionCapabilityTypes;
