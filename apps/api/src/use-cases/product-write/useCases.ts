import { randomUUID } from "node:crypto";
import { ProductStatus, ProductType } from "@noctella/shared";
import type { ProductWriteRepositoryBundle } from "../../repositories/product-write/types";
import { BadRequestError, ConflictError, NotFoundError, ProductVersionConflictError } from "../../services/errors";
import type { UnitOfWork } from "../../services/unitOfWork";
import type { InventoryApplicationContext } from "../../services/inventoryApplicationContext";
import type { AsynchronousProductWriteTransactionContext } from "../../application/product-write/transactionCapabilities";
import { initializeInventoryInTransactionUseCase, setInventoryQuantityInTransactionUseCase } from "../../application/inventory";
import { slugify } from "../../validation/common";
import type { CreateProductInput, UpdateProductCommandInput, UpdateProductInput } from "../../validation/product";
import type { CreateCategoryInput, UpdateCategoryInput } from "../../validation/category";
import type { CreateCollectionInput, UpdateCollectionInput } from "../../validation/collection";

export interface ProductWriteUseCaseContext { unitOfWork: UnitOfWork; repositories: ProductWriteRepositoryBundle }
type ProductInventoryWriteContext = Omit<InventoryApplicationContext, "unitOfWork"> & { unitOfWork: { run<T>(work: (context: AsynchronousProductWriteTransactionContext) => T | Promise<T>): Promise<Awaited<T>> } };
const now = () => new Date().toISOString();
/**
 * Sprint 88 (ADR-017): a successful Product update must always produce a
 * version token strictly newer than the one it conditionally replaced - two
 * updates landing in the same millisecond must not collapse to an identical
 * updatedAt, which would make the next caller's expectedUpdatedAt ambiguous.
 * Falls back to the current clock for a legacy/non-parseable stored value.
 *
 * Sprint 89 correction: PostgreSQL's Drizzle timestamp columns (no
 * `mode:"string"`) return real Date objects at runtime despite the shared
 * types declaring `string` - current.updatedAt/baseProductUpdatedAt can
 * reach this function as either. Date.parse(Date) is unsafe: it coerces the
 * Date to its default (non-ISO) string form first, which has no
 * milliseconds field, silently truncating them and breaking strict
 * monotonicity. A Date input must use getTime() directly; only a genuine
 * string input goes through Date.parse.
 */
function nextUpdatedAt(currentUpdatedAt: string | Date): string {
  const nowMs = Date.now();
  const currentMs = currentUpdatedAt instanceof Date ? currentUpdatedAt.getTime() : Date.parse(currentUpdatedAt);
  if (Number.isNaN(currentMs)) return new Date(nowMs).toISOString();
  return new Date(Math.max(nowMs, currentMs + 1)).toISOString();
}
const nullable = (v: unknown): string | number | boolean | null => v === undefined || v === null ? null : (typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : JSON.stringify(v));
function stock(type: ProductType, requested?: number) { if (type === ProductType.UniqueItem) { const q = requested ?? 1; if (q > 1) throw new BadRequestError("Unique Item stock quantity cannot exceed 1"); return q; } return requested ?? 1; }
function productValues(input: CreateProductInput | UpdateProductInput, extra: Record<string, unknown> = {}) { const out: Record<string, unknown> = { ...extra }; for (const [k,v] of Object.entries(input as Record<string, unknown>)) { if (k === "images" || k === "expectedUpdatedAt" || v === undefined) continue; out[k] = Array.isArray(v) ? JSON.stringify(v) : nullable(v); } return out as Record<string, string|number|boolean|null>; }
const chain = <T, U>(value: T | Promise<T>, next: (value: T) => U | Promise<U>) => value instanceof Promise ? value.then(next) : next(value);

/**
 * Sprint 50B: structural shape covering only the ERP-metadata-related
 * methods of ProductWriteRepository/SynchronousProductWriteRepository, so
 * the same upsert logic below can run against either the transaction-scoped
 * synchronous (SQLite) repository or the asynchronous (Postgres) one without
 * duplicating the business logic per driver.
 */
interface ErpMetadataCapableRepository {
  existsByNoctellaId(noctellaId: string, excludeProductId?: string): Promise<boolean> | boolean;
  getErpMetadataForUpdate(productId: string): Promise<unknown> | unknown;
  createErpMetadata(record: any): Promise<void> | void;
  updateErpMetadata(productId: string, values: any): Promise<void> | void;
}
/**
 * Shared ERP-metadata upsert logic, extracted so it can run either inside an
 * existing product-write transaction (createProductWithInventoryUseCase,
 * updateProductWithInventoryUseCase) or standalone via the unchanged
 * upsertProductErpMetadataUseCase. Same validation and create-or-update
 * behavior in both cases — only which repository reference is passed in
 * differs (transaction-scoped vs. not).
 */
function upsertErpMetadataInTransaction(repo: ErpMetadataCapableRepository, productId: string, metadata: Record<string, unknown>) {
  const clean = Object.fromEntries(Object.entries(metadata).filter(([, v]) => v !== undefined).map(([k, v]) => [k, nullable(v)]));
  if (!Object.keys(clean).length) return undefined;
  const t = now();
  return chain(clean.noctellaId ? repo.existsByNoctellaId(String(clean.noctellaId), productId) : false, (duplicate) => {
    if (duplicate) throw new ConflictError("noctellaId is already in use");
    return chain(repo.getErpMetadataForUpdate(productId), (existing) =>
      existing ? repo.updateErpMetadata(productId, { ...clean, updatedAt: t } as any) : repo.createErpMetadata({ productId, ...clean, createdAt: t, updatedAt: t } as any),
    );
  });
}
/**
 * Sprint 94: the transaction-scoped body of createProductWithInventoryUseCase,
 * extracted so a caller that already owns a transaction spanning other
 * domains (e.g. AI Intake Save as Draft) can run the identical canonical
 * atomic Product creation, Inventory initialization, and ERP-metadata
 * behavior inside its own transaction, instead of createProductWithInventoryUseCase
 * opening a second (nested) one - mirrors the Sprint 89 precedent
 * (updateProductWithInventoryInTransactionUseCase) exactly. Takes repositories
 * already bound to the caller's transaction handle - never opens a
 * transaction itself. SKU-uniqueness is checked here (inside the transaction)
 * rather than by the caller beforehand, so any caller composing this into a
 * larger transaction gets the same conflict guarantee for free.
 */
export function createProductWithInventoryInTransactionUseCase(
  repositories: AsynchronousProductWriteTransactionContext["repositories"],
  inventoryCtx: Pick<InventoryApplicationContext, "clock" | "idGenerator">,
  input: CreateProductInput,
  erpMetadata?: Record<string, unknown>,
) {
  const quantity = stock(input.type, input.stockQuantity);
  const slug = input.slug ? slugify(input.slug) : slugify(input.title);
  const t = now(), id = randomUUID();
  return chain(repositories.productWriteRepositories.products.existsBySku(input.sku), (exists) => {
    if (exists) throw new ConflictError(`SKU "${input.sku}" is already in use`);
    return chain(
      repositories.productWriteRepositories.products.create({ values: productValues(input, {
        id, slug, createdAt: t, updatedAt: t,
      }) }),
      () => chain(
        input.stockQuantity === undefined ? { id } : chain(
          initializeInventoryInTransactionUseCase(inventoryCtx, repositories.inventoryRepositories, {
            productId: id, quantity, idempotencyKey: `product-create-stock:${id}`, note: "Product creation stock quantity",
          }),
          () => ({ id }),
        ),
        (result) => erpMetadata ? chain(upsertErpMetadataInTransaction(repositories.productWriteRepositories.products, id, erpMetadata), () => result) : result,
      ),
    );
  });
}

export function createProductWithInventoryUseCase(ctx: ProductInventoryWriteContext, input: CreateProductInput, erpMetadata?: Record<string, unknown>) {
  return ctx.unitOfWork.run(({ repositories }) => createProductWithInventoryInTransactionUseCase(repositories, ctx, input, erpMetadata));
}

/**
 * Sprint 89: the transaction-scoped body of updateProductWithInventoryUseCase,
 * extracted so a caller that already owns a transaction spanning other
 * domains (e.g. AI Draft approval) can run the identical canonical atomic
 * Product update, Inventory sequencing, and ERP-metadata behavior inside its
 * own transaction, instead of updateProductWithInventoryUseCase opening a
 * second (nested) one. Takes repositories already bound to the caller's
 * transaction handle - never opens a transaction itself.
 *
 * Sprint 89 correction: this function - not its callers - owns the
 * monotonic-version invariant. `input.values` must contain business fields
 * only; any `updatedAt` key it happens to carry is discarded, and a fresh
 * value is always computed from `currentUpdatedAtForNextVersion` via the
 * same nextUpdatedAt used everywhere else, so no caller (manual update or AI
 * Draft approval) can omit or suppress a Product's version advancement. The
 * same generated value is reused for Inventory's expectedVersion and its
 * idempotency key when stock is being updated. Reuses updateWithExpectedVersion,
 * ProductVersionConflictError, and NotFoundError unchanged.
 */
export function updateProductWithInventoryInTransactionUseCase(
  repositories: AsynchronousProductWriteTransactionContext["repositories"],
  inventoryCtx: Pick<InventoryApplicationContext, "clock" | "idGenerator">,
  input: {
    id: string;
    values: Record<string, string | number | boolean | null>;
    expectedUpdatedAt: string;
    /**
     * Sprint 89 correction: accepts either representation actually produced by
     * the repository layer at runtime (a genuine string on SQLite, a real Date
     * object on PostgreSQL timestamp columns) - see nextUpdatedAt above.
     */
    currentUpdatedAtForNextVersion: string | Date;
    stockQuantity?: number;
    currentStockQuantity?: number;
  },
  erpMetadata?: Record<string, unknown>,
) {
  const { id, expectedUpdatedAt, stockQuantity, currentStockQuantity, currentUpdatedAtForNextVersion } = input;
  const { updatedAt: _ignoredCallerSuppliedUpdatedAt, ...businessValues } = input.values;
  const newUpdatedAt = nextUpdatedAt(currentUpdatedAtForNextVersion);
  const values = { ...businessValues, updatedAt: newUpdatedAt };
  return chain(
    repositories.productWriteRepositories.products.updateWithExpectedVersion({ id, values, expectedUpdatedAt }),
    (updated) => {
      if (!updated.updated) {
        if (updated.conflict?.field === "id") throw new NotFoundError(updated.conflict.message);
        throw new ProductVersionConflictError(id, expectedUpdatedAt, updated.conflict?.currentValue ?? null);
      }
      return chain(
        stockQuantity === undefined || stockQuantity === currentStockQuantity ? { id, updated: true } : chain(
          setInventoryQuantityInTransactionUseCase(inventoryCtx, repositories.inventoryRepositories, {
            productId: id, quantity: stockQuantity, expectedVersion: newUpdatedAt,
            idempotencyKey: `product-update-stock:${id}:${currentUpdatedAtForNextVersion}:${stockQuantity}`,
            note: "Product update stock quantity",
          }),
          () => ({ id, updated: true }),
        ),
        (result) => erpMetadata ? chain(upsertErpMetadataInTransaction(repositories.productWriteRepositories.products, id, erpMetadata), () => result) : result,
      );
    },
  );
}

export function updateProductWithInventoryUseCase(
  ctx: ProductInventoryWriteContext,
  id: string,
  input: UpdateProductCommandInput,
  erpMetadata?: Record<string, unknown>,
) {
  return chain(ctx.repositories.products.findById(id), (current) => {
    if (!current) throw new NotFoundError("Product not found");
    return chain(input.sku ? ctx.repositories.products.existsBySku(input.sku, id) : false, (duplicate) => {
      if (duplicate) throw new ConflictError(`SKU "${input.sku}" is already in use`);
      const { stockQuantity, expectedUpdatedAt, ...metadata } = input;
      // Sprint 88: explicit caller token is authoritative when supplied; a trusted internal caller
      // that omits it falls back to the value just read above (command-time optimistic
      // concurrency) - the HTTP route always supplies one, since its request validation requires
      // the field. expectedUpdatedAt is never included in `metadata`/persisted Product values.
      const effectiveExpectedUpdatedAt = expectedUpdatedAt ?? current.updatedAt;
      // Sprint 89 correction: updatedAt is no longer computed/injected here - the
      // transaction-scoped canonical function now owns generating and injecting the
      // monotonic version, so it cannot be omitted by any caller.
      const values = productValues(metadata, { ...(input.slug !== undefined ? { slug: slugify(input.slug) } : {}) });
      return ctx.unitOfWork.run(({ repositories }) => updateProductWithInventoryInTransactionUseCase(
        repositories,
        ctx,
        { id, values, expectedUpdatedAt: effectiveExpectedUpdatedAt, currentUpdatedAtForNextVersion: current.updatedAt, stockQuantity, currentStockQuantity: current.stockQuantity },
        erpMetadata,
      ));
    });
  });
}
export async function createCategoryUseCase(ctx: ProductWriteUseCaseContext, input: CreateCategoryInput) { const slug = input.slug ? slugify(input.slug) : slugify(input.name); if (await ctx.repositories.categories.existsBySlug(slug)) throw new ConflictError(`Category slug "${slug}" is already in use`); const t = now(), id = randomUUID(); return ctx.unitOfWork.run(() => ctx.repositories.categories.create({ values: { id, name: input.name, slug, description: nullable(input.description), parentId: nullable(input.parentId), displayImageUrl: nullable(input.displayImageUrl), seoTitle: nullable(input.seoTitle), metaDescription: nullable(input.metaDescription), displayOrder: input.displayOrder, isActive: input.isActive, createdAt: t, updatedAt: t } })); }
export async function updateCategoryUseCase(ctx: ProductWriteUseCaseContext, id: string, input: UpdateCategoryInput) { if (!await ctx.repositories.categories.getVersionForUpdate(id)) throw new NotFoundError("Category not found"); const values: Record<string, string|number|boolean|null> = { updatedAt: now() }; if (input.slug !== undefined) { const slug = slugify(input.slug); if (await ctx.repositories.categories.existsBySlug(slug, id)) throw new ConflictError(`Category slug "${slug}" is already in use`); values.slug = slug; } for (const [k,v] of Object.entries(input)) if (k !== "slug") values[k] = nullable(v) as string|number|boolean|null; return ctx.unitOfWork.run(() => ctx.repositories.categories.update({ id, values })); }
export async function createCollectionUseCase(ctx: ProductWriteUseCaseContext, input: CreateCollectionInput) { const slug = input.slug ? slugify(input.slug) : slugify(input.name); if (await ctx.repositories.collections.existsBySlug(slug)) throw new ConflictError(`Collection slug "${slug}" is already in use`); const t = now(), id = randomUUID(); return ctx.unitOfWork.run(() => ctx.repositories.collections.create({ values: { id, name: input.name, slug, description: nullable(input.description), coverImageUrl: nullable(input.coverImageUrl), seoTitle: nullable(input.seoTitle), metaDescription: nullable(input.metaDescription), displayOrder: input.displayOrder, isActive: input.isActive, createdAt: t, updatedAt: t } })); }
export async function updateCollectionUseCase(ctx: ProductWriteUseCaseContext, id: string, input: UpdateCollectionInput) { if (!await ctx.repositories.collections.getVersionForUpdate(id)) throw new NotFoundError("Collection not found"); const values: Record<string, string|number|boolean|null> = { updatedAt: now() }; if (input.slug !== undefined) { const slug = slugify(input.slug); if (await ctx.repositories.collections.existsBySlug(slug, id)) throw new ConflictError(`Collection slug "${slug}" is already in use`); values.slug = slug; } for (const [k,v] of Object.entries(input)) if (k !== "slug") values[k] = nullable(v) as string|number|boolean|null; return ctx.unitOfWork.run(() => ctx.repositories.collections.update({ id, values })); }
export async function updateProductPhotoAltUseCase(ctx: ProductWriteUseCaseContext, input: { productId: string; photoId: string; altText?: string | null }) { const p = await ctx.repositories.photos.getForUpdate(input.productId, input.photoId); if (!p) throw new NotFoundError("Product photo not found"); return ctx.unitOfWork.run(() => ctx.repositories.photos.updateAltText({ ...input, altText: input.altText ?? null })); }
export async function setPrimaryProductPhotoUseCase(ctx: ProductWriteUseCaseContext, input: { productId: string; photoId: string }) { const p = await ctx.repositories.photos.getForUpdate(input.productId, input.photoId); if (!p) throw new NotFoundError("Product photo not found"); return ctx.unitOfWork.run(() => ctx.repositories.photos.setPrimary(input)); }
export async function reorderProductPhotosUseCase(ctx: ProductWriteUseCaseContext, input: { productId: string; photoIds: string[] }) { const photos = await ctx.repositories.photos.listForUpdate(input.productId); const unique = new Set(input.photoIds); if (photos.length !== input.photoIds.length || unique.size !== input.photoIds.length || photos.some((p: any) => !unique.has(String(p.id)))) throw new BadRequestError("Reorder payload must include every product photo exactly once"); return ctx.unitOfWork.run(() => ctx.repositories.photos.reorder(input)); }
export async function deleteProductPhotoMetadataUseCase(ctx: ProductWriteUseCaseContext, input: { productId: string; photoId: string }) { const p = await ctx.repositories.photos.getForUpdate(input.productId, input.photoId); if (!p) throw new NotFoundError("Product photo not found"); return ctx.unitOfWork.run(async () => { await ctx.repositories.photos.deleteMetadata(input); await ctx.repositories.photos.reorder({ productId: input.productId, photoIds: (await ctx.repositories.photos.listForUpdate(input.productId)).map((x: any) => String(x.id)) }); await ctx.repositories.photos.promoteNextPrimary(input.productId); }); }

export async function archiveProductUseCase(ctx: ProductWriteUseCaseContext, id: string) { if (!await ctx.repositories.products.getVersionForUpdate(id)) throw new NotFoundError("Product not found"); return ctx.unitOfWork.run(() => ctx.repositories.products.update({ id, values: { status: ProductStatus.Archived, updatedAt: now() } })); }
export async function archiveCategoryUseCase(ctx: ProductWriteUseCaseContext, id: string) { if (!await ctx.repositories.categories.getVersionForUpdate(id)) throw new NotFoundError("Category not found"); return ctx.unitOfWork.run(() => ctx.repositories.categories.update({ id, values: { isActive: false, updatedAt: now() } })); }
export async function restoreCategoryUseCase(ctx: ProductWriteUseCaseContext, id: string) { if (!await ctx.repositories.categories.getVersionForUpdate(id)) throw new NotFoundError("Category not found"); return ctx.unitOfWork.run(() => ctx.repositories.categories.update({ id, values: { isActive: true, updatedAt: now() } })); }
export async function archiveCollectionUseCase(ctx: ProductWriteUseCaseContext, id: string) { if (!await ctx.repositories.collections.getVersionForUpdate(id)) throw new NotFoundError("Collection not found"); return ctx.unitOfWork.run(() => ctx.repositories.collections.update({ id, values: { isActive: false, updatedAt: now() } })); }
export async function restoreCollectionUseCase(ctx: ProductWriteUseCaseContext, id: string) { if (!await ctx.repositories.collections.getVersionForUpdate(id)) throw new NotFoundError("Collection not found"); return ctx.unitOfWork.run(() => ctx.repositories.collections.update({ id, values: { isActive: true, updatedAt: now() } })); }
export function upsertProductErpMetadataUseCase(ctx: ProductWriteUseCaseContext, productId: string, metadata: Record<string, unknown>) { return ctx.unitOfWork.run(() => upsertErpMetadataInTransaction(ctx.repositories.products, productId, metadata)); }
