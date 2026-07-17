import type { InventoryRepository } from "../repositories/inventory/inventoryRepository";
import type { ProductRepository } from "../repositories/inventory/productRepository";
import type { StockLocationRepository } from "../repositories/inventory/stockLocationRepository";
import type { StockMovementRepository } from "../repositories/inventory/stockMovementRepository";
import type { UnitOfWork } from "./unitOfWork";

export interface InventoryRepositoryBundle {
  products: ProductRepository;
  inventory: InventoryRepository;
  stockMovements: StockMovementRepository;
  stockLocations: StockLocationRepository;
}

export interface InventoryClock {
  now(): Date;
}

export interface InventoryIdGenerator {
  newId(): string;
}

export interface InventoryLogger {
  debug?(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
}

export interface InventoryApplicationConfiguration {
  readonly inventoryApplicationContext: true;
}

export interface InventoryApplicationContext {
  readonly repositories: Readonly<InventoryRepositoryBundle>;
  readonly productRepository: ProductRepository;
  readonly inventoryRepository: InventoryRepository;
  readonly stockMovementRepository: StockMovementRepository;
  readonly stockLocationRepository: StockLocationRepository;
  readonly unitOfWork: UnitOfWork;
  readonly clock: InventoryClock;
  readonly idGenerator: InventoryIdGenerator;
  readonly logger: InventoryLogger;
  readonly configuration: InventoryApplicationConfiguration;
}

export interface BuildInventoryApplicationContextInput {
  readonly repositories: InventoryRepositoryBundle;
  readonly unitOfWork: UnitOfWork;
  readonly clock: InventoryClock;
  readonly idGenerator: InventoryIdGenerator;
  readonly logger: InventoryLogger;
  readonly configuration?: InventoryApplicationConfiguration;
}

const requiredKeys: Array<keyof BuildInventoryApplicationContextInput> = [
  "repositories",
  "unitOfWork",
  "clock",
  "idGenerator",
  "logger",
];

const requiredRepositoryKeys: Array<keyof InventoryRepositoryBundle> = [
  "products",
  "inventory",
  "stockMovements",
  "stockLocations",
];

export function buildInventoryApplicationContext(
  dependencies: BuildInventoryApplicationContextInput,
): InventoryApplicationContext {
  for (const key of requiredKeys) {
    if (dependencies[key] == null) {
      throw new Error(`INVENTORY_APPLICATION_CONTEXT_MISSING_${key}`);
    }
  }

  for (const key of requiredRepositoryKeys) {
    if (dependencies.repositories[key] == null) {
      throw new Error(`INVENTORY_APPLICATION_CONTEXT_MISSING_REPOSITORY_${key}`);
    }
  }

  const repositories = Object.freeze({ ...dependencies.repositories });
  return Object.freeze({
    repositories,
    productRepository: repositories.products,
    inventoryRepository: repositories.inventory,
    stockMovementRepository: repositories.stockMovements,
    stockLocationRepository: repositories.stockLocations,
    unitOfWork: dependencies.unitOfWork,
    clock: dependencies.clock,
    idGenerator: dependencies.idGenerator,
    logger: dependencies.logger,
    configuration:
      dependencies.configuration ??
      Object.freeze({ inventoryApplicationContext: true as const }),
  });
}
