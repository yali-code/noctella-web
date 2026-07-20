import type { ProductWriteRepository, SynchronousProductWriteRepository } from "../../repositories/product-write/types";
import type { InventoryRepositoryBundle } from "../../services/inventoryApplicationContext";

export interface SynchronousProductWriteTransactionContext { readonly repositories: Readonly<{ productWriteRepositories: Readonly<{ products: SynchronousProductWriteRepository }>; inventoryRepositories: InventoryRepositoryBundle }> }
export interface AsynchronousProductWriteTransactionContext { readonly repositories: Readonly<{ productWriteRepositories: Readonly<{ products: ProductWriteRepository }>; inventoryRepositories: InventoryRepositoryBundle }> }
type SynchronousWork<T> = (context: SynchronousProductWriteTransactionContext) => T extends PromiseLike<unknown> ? never : T;
export interface SynchronousProductWriteTransactionCapability { readonly driver: "sqlite" | "test-memory"; readonly execution: "synchronous"; run<T>(work: SynchronousWork<T>): T }
export interface AsynchronousProductWriteTransactionCapability { readonly driver: "postgres" | "supabase-postgres"; readonly execution: "asynchronous"; run<T>(work: (context: AsynchronousProductWriteTransactionContext) => T | Promise<T>): Promise<Awaited<T>> }
export interface ProductWriteTransactionCapabilityByDriver { readonly sqlite: SynchronousProductWriteTransactionCapability; readonly "test-memory": SynchronousProductWriteTransactionCapability; readonly postgres: AsynchronousProductWriteTransactionCapability; readonly "supabase-postgres": AsynchronousProductWriteTransactionCapability }
export type ProductWriteTransactionDriver = keyof ProductWriteTransactionCapabilityByDriver;
export type ProductWriteTransactionCapabilityFor<Driver extends ProductWriteTransactionDriver> = ProductWriteTransactionCapabilityByDriver[Driver];
