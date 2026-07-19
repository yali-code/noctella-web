import crypto from "node:crypto";
import type { DbClient } from "../db/client";
import { createInventoryRepositoryBundleForDb } from "../repositories/inventory/factory";
import { buildInventoryApplicationContext, type InventoryApplicationContext } from "./inventoryApplicationContext";

export function createInventoryApplicationContextForDb(db: DbClient): InventoryApplicationContext {
  return buildInventoryApplicationContext({
    repositories: createInventoryRepositoryBundleForDb(db),
    unitOfWork: { run: (work) => work({ repositories: { inventoryRepositories: createInventoryRepositoryBundleForDb(db) } } as never) as never },
    clock: { now: () => new Date() },
    idGenerator: { newId: () => crypto.randomUUID() },
    logger: {},
  });
}
