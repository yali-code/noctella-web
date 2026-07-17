import crypto from "node:crypto";
import type { DbClient } from "../db/client";
import { createPurchaseRepositoriesForDb } from "../repositories/purchase/factory";
import type { PurchaseRepositoryDriver } from "../repositories/purchase/types";
import {
  buildPurchaseApplicationContext,
  type PurchaseApplicationContext,
  type PurchaseLogger,
} from "./purchaseApplicationContext";
import { PostgresUnitOfWork, SqliteUnitOfWork, type UnitOfWork } from "./unitOfWork";

export interface CreatePurchaseApplicationContextForDbInput {
  readonly db: DbClient;
  readonly driver?: PurchaseRepositoryDriver;
  readonly unitOfWork?: UnitOfWork;
  readonly logger?: PurchaseLogger;
}

function unitOfWorkForDb(db: DbClient, driver: PurchaseRepositoryDriver): UnitOfWork {
  if (driver === "postgres" || driver === "supabase-postgres") {
    return new PostgresUnitOfWork(db as never);
  }
  return new SqliteUnitOfWork(db);
}

export function createPurchaseApplicationContextForDb(
  input: DbClient | CreatePurchaseApplicationContextForDbInput,
): PurchaseApplicationContext {
  const options = "db" in (input as CreatePurchaseApplicationContextForDbInput)
    ? (input as CreatePurchaseApplicationContextForDbInput)
    : { db: input as DbClient };
  const driver = options.driver ?? "sqlite";
  return buildPurchaseApplicationContext({
    purchaseRepositories: createPurchaseRepositoriesForDb(options.db, driver),
    unitOfWork: options.unitOfWork ?? unitOfWorkForDb(options.db, driver),
    logger: options.logger ?? {},
    clock: { now: () => new Date() },
    idGenerator: { newId: () => crypto.randomUUID() },
    configuration: Object.freeze({ purchaseApplicationContext: true as const, driver }),
  });
}
