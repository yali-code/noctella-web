import type { InventoryRepository } from "../../repositories/inventory/inventoryRepository";
import type { ProductRepository } from "../../repositories/inventory/productRepository";
import type { StockLocationRepository } from "../../repositories/inventory/stockLocationRepository";
import type { StockMovementRepository } from "../../repositories/inventory/stockMovementRepository";

interface TransactionScopedInventoryRepositories {
  readonly products: ProductRepository;
  readonly inventory: InventoryRepository;
  readonly stockMovements: StockMovementRepository;
  readonly stockLocations: StockLocationRepository;
}

export interface InventoryTransactionContext {
  readonly repositories: Readonly<{
    inventoryRepositories: TransactionScopedInventoryRepositories;
  }>;
}

type SynchronousWork<T> = (
  context: InventoryTransactionContext,
) => T extends PromiseLike<unknown> ? never : T;

export interface SynchronousInventoryTransactionCapability {
  readonly driver: "sqlite" | "test-memory";
  readonly execution: "synchronous";
  run<T>(work: SynchronousWork<T>): T;
}

export interface AsynchronousInventoryTransactionCapability {
  readonly driver: "postgres" | "supabase-postgres";
  readonly execution: "asynchronous";
  run<T>(
    work: (context: InventoryTransactionContext) => T | Promise<T>,
  ): Promise<Awaited<T>>;
}

export interface PassThroughInventoryUnitOfWork {
  run<T>(
    work: (context: InventoryTransactionContext) => T | Promise<T>,
  ): Promise<Awaited<T>>;
}

export interface InventoryTransactionCapabilityByDriver {
  readonly sqlite: SynchronousInventoryTransactionCapability;
  readonly "test-memory": SynchronousInventoryTransactionCapability;
  readonly postgres: AsynchronousInventoryTransactionCapability;
  readonly "supabase-postgres": AsynchronousInventoryTransactionCapability;
}

export type InventoryTransactionDriver =
  keyof InventoryTransactionCapabilityByDriver;

export type InventoryTransactionCapabilityFor<
  Driver extends InventoryTransactionDriver,
> = InventoryTransactionCapabilityByDriver[Driver];
