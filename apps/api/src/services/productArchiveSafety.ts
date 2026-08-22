import type { DbClient } from "../db/client";
import { createProductLifecycleRepository } from "../repositories/product-lifecycle/factory";
import { ConflictError } from "./errors";
import type { ProductArchiveSafety } from "@noctella/shared";

const TERMINAL_EXTERNAL_STATUSES = ["ended", "inactive", "sold", "closed"];
const UNSAFE_REASON = "Product cannot be archived while sales shutdown is incomplete";

/** Read-only Archive preflight. The mutation assertion below deliberately delegates to this rule. */
export async function evaluateProductArchiveSafety(db: DbClient, productId: string): Promise<ProductArchiveSafety> {
  const repository = createProductLifecycleRepository(db);
  if (await repository.hasNonTerminalExternalListing(productId, TERMINAL_EXTERNAL_STATUSES)) {
    return { canArchive: false, reason: UNSAFE_REASON };
  }
  const operation = await repository.getLatest(productId);
  if (!operation) return { canArchive: true };
  const unresolved = operation.status !== "succeeded" || operation.targetResults.some((target) => target.status !== "succeeded");
  return unresolved ? { canArchive: false, reason: UNSAFE_REASON } : { canArchive: true };
}

/** Authoritative server-side Archive guard; never mutates lifecycle or marketplace history. */
export async function assertProductArchiveSafe(db: DbClient, productId: string): Promise<void> {
  const safety = await evaluateProductArchiveSafety(db, productId);
  if (!safety.canArchive) throw new ConflictError(safety.reason ?? UNSAFE_REASON);
}
