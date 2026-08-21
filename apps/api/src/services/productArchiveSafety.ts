import type { DbClient } from "../db/client";
import { createProductLifecycleRepository } from "../repositories/product-lifecycle/factory";
import { ConflictError } from "./errors";

const TERMINAL_EXTERNAL_STATUSES = ["ended", "inactive", "sold", "closed"];

/** Authoritative server-side Archive guard; never mutates lifecycle or marketplace history. */
export async function assertProductArchiveSafe(db: DbClient, productId: string): Promise<void> {
  const repository = createProductLifecycleRepository(db);
  if (await repository.hasNonTerminalExternalListing(productId, TERMINAL_EXTERNAL_STATUSES)) {
    throw new ConflictError("Product cannot be archived while sales shutdown is incomplete");
  }
  const operation = await repository.getLatest(productId);
  if (!operation) return;
  const unresolved = operation.status !== "succeeded" || operation.targetResults.some((target) => target.status !== "succeeded");
  if (unresolved) throw new ConflictError("Product cannot be archived while sales shutdown is incomplete");
}
