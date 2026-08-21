import type { ProductLifecycleOperation } from "@noctella/shared";
export interface ProductLifecycleRepository {
  getById(id: string): Promise<ProductLifecycleOperation | undefined>;
  getByIdempotencyKey(key: string): Promise<ProductLifecycleOperation | undefined>;
  getLatest(productId: string): Promise<ProductLifecycleOperation | undefined>;
  create(values: Record<string, unknown>): Promise<void>;
  update(id: string, values: Record<string, unknown>): Promise<void>;
}
