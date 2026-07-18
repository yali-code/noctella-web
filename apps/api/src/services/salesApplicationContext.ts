import type { SaleRepository, SalesRepositories } from "../repositories/sales/types";
import type { UnitOfWork } from "./unitOfWork";
import { unavailableSalesCompletionCoordinator, type SalesCompletionCoordinator } from "../application/sales/completionCoordination";

export interface SalesClock {
  now(): Date;
}

export interface SalesIdGenerator {
  newId(): string;
}

export interface SalesLogger {
  debug?(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
}

export interface SalesApplicationConfiguration {
  readonly salesApplicationContext: true;
  readonly driver?: string;
}

export interface SalesApplicationContext {
  readonly salesRepositories: Readonly<SalesRepositories>;
  readonly saleRepository: SaleRepository;
  readonly unitOfWork: UnitOfWork;
  readonly logger: SalesLogger;
  readonly clock: SalesClock;
  readonly idGenerator: SalesIdGenerator;
  readonly completionCoordinator: SalesCompletionCoordinator;
  readonly configuration: SalesApplicationConfiguration;
}

export interface BuildSalesApplicationContextInput {
  readonly salesRepositories: SalesRepositories;
  readonly unitOfWork: UnitOfWork;
  readonly logger: SalesLogger;
  readonly clock: SalesClock;
  readonly idGenerator: SalesIdGenerator;
  readonly completionCoordinator?: SalesCompletionCoordinator;
  readonly configuration?: SalesApplicationConfiguration;
}

const requiredKeys: Array<keyof BuildSalesApplicationContextInput> = [
  "salesRepositories",
  "unitOfWork",
  "logger",
  "clock",
  "idGenerator",
];

const requiredRepositoryKeys: Array<keyof SalesRepositories> = ["saleRepository"];

export function buildSalesApplicationContext(
  dependencies: BuildSalesApplicationContextInput,
): SalesApplicationContext {
  for (const key of requiredKeys) {
    if (dependencies[key] == null) {
      throw new Error(`SALES_APPLICATION_CONTEXT_MISSING_${key}`);
    }
  }

  for (const key of requiredRepositoryKeys) {
    if (dependencies.salesRepositories[key] == null) {
      throw new Error(`SALES_APPLICATION_CONTEXT_MISSING_REPOSITORY_${key}`);
    }
  }

  const salesRepositories = Object.freeze({ ...dependencies.salesRepositories });
  return Object.freeze({
    salesRepositories,
    saleRepository: salesRepositories.saleRepository,
    unitOfWork: dependencies.unitOfWork,
    logger: dependencies.logger,
    clock: dependencies.clock,
    idGenerator: dependencies.idGenerator,
    completionCoordinator: dependencies.completionCoordinator ?? unavailableSalesCompletionCoordinator,
    configuration: Object.freeze({
      ...(dependencies.configuration ?? { salesApplicationContext: true as const }),
    }),
  });
}
