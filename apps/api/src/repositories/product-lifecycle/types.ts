import type { ProductLifecycleOperation, ProductLifecycleTarget, PublishChannel } from "@noctella/shared";
export interface ProductLifecycleRepository {
  getById(id: string): Promise<ProductLifecycleOperation | undefined>;
  getByIdempotencyKey(key: string): Promise<ProductLifecycleOperation | undefined>;
  getLatest(productId: string): Promise<ProductLifecycleOperation | undefined>;
  create(values: Record<string, unknown>): Promise<void>;
  update(id: string, values: Record<string, unknown>): Promise<void>;
  replaceResultsIfCurrent(id: string, expected: ProductLifecycleTarget[], next: ProductLifecycleTarget[]): Promise<boolean>;
  getOriginalConnection(connectionId: string, channel: PublishChannel): Promise<Record<string, any> | undefined>;
  updateExternalListingStatus(productId: string, internalListingId: string, status: string): Promise<void>;
  hasNonTerminalExternalListing(productId: string, terminalStatuses: string[]): Promise<boolean>;
}
