import type {
  PurchaseReceiptRepository,
  PurchaseRepositories,
  PurchaseRepository,
  SupplierRepository,
} from "../repositories/purchase/types";
import type { UnitOfWork } from "./unitOfWork";
import type { PurchaseEventPublisher } from "../events/purchase";
import type { PurchaseObservability } from "../observability/purchase";
import { noopPurchaseEventPublisher } from "../events/purchase";
import { noopPurchaseObservability } from "../observability/purchase";

export interface PurchaseClock {
  now(): Date;
}

export interface PurchaseIdGenerator {
  newId(): string;
}

export interface PurchaseLogger {
  debug?(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
}

export interface PurchaseApplicationConfiguration {
  readonly purchaseApplicationContext: true;
  readonly driver?: string;
}

export interface PurchaseApplicationContext {
  readonly purchaseRepositories: Readonly<PurchaseRepositories>;
  readonly purchaseRepository: PurchaseRepository;
  readonly supplierRepository: SupplierRepository;
  readonly purchaseReceiptRepository: PurchaseReceiptRepository;
  readonly unitOfWork: UnitOfWork;
  readonly logger: PurchaseLogger;
  readonly clock: PurchaseClock;
  readonly idGenerator: PurchaseIdGenerator;
  readonly eventPublisher: PurchaseEventPublisher;
  readonly observability: PurchaseObservability;
  readonly configuration: PurchaseApplicationConfiguration;
}

export interface BuildPurchaseApplicationContextInput {
  readonly purchaseRepositories: PurchaseRepositories;
  readonly unitOfWork: UnitOfWork;
  readonly logger: PurchaseLogger;
  readonly clock: PurchaseClock;
  readonly idGenerator: PurchaseIdGenerator;
  readonly eventPublisher?: PurchaseEventPublisher;
  readonly observability?: PurchaseObservability;
  readonly configuration?: PurchaseApplicationConfiguration;
}

const requiredKeys: Array<keyof BuildPurchaseApplicationContextInput> = [
  "purchaseRepositories",
  "unitOfWork",
  "logger",
  "clock",
  "idGenerator",
];

const requiredRepositoryKeys: Array<keyof PurchaseRepositories> = [
  "purchases",
  "suppliers",
  "receipts",
];

export function buildPurchaseApplicationContext(
  dependencies: BuildPurchaseApplicationContextInput,
): PurchaseApplicationContext {
  for (const key of requiredKeys) {
    if (dependencies[key] == null) {
      throw new Error(`PURCHASE_APPLICATION_CONTEXT_MISSING_${key}`);
    }
  }

  for (const key of requiredRepositoryKeys) {
    if (dependencies.purchaseRepositories[key] == null) {
      throw new Error(`PURCHASE_APPLICATION_CONTEXT_MISSING_REPOSITORY_${key}`);
    }
  }

  const purchaseRepositories = Object.freeze({
    ...dependencies.purchaseRepositories,
  });
  return Object.freeze({
    purchaseRepositories,
    purchaseRepository: purchaseRepositories.purchases,
    supplierRepository: purchaseRepositories.suppliers,
    purchaseReceiptRepository: purchaseRepositories.receipts,
    unitOfWork: dependencies.unitOfWork,
    logger: dependencies.logger,
    clock: dependencies.clock,
    idGenerator: dependencies.idGenerator,
    eventPublisher: dependencies.eventPublisher ?? noopPurchaseEventPublisher,
    observability: dependencies.observability ?? noopPurchaseObservability,
    configuration:
      dependencies.configuration ??
      Object.freeze({ purchaseApplicationContext: true as const }),
  });
}
