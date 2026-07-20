import { randomUUID } from "node:crypto";
import { ProductStatus, ProductType } from "@noctella/shared";
import type { ProductWriteRepositoryBundle } from "../../repositories/product-write/types";
import { BadRequestError, ConflictError, NotFoundError } from "../../services/errors";
import type { UnitOfWork } from "../../services/unitOfWork";
import type { InventoryApplicationContext } from "../../services/inventoryApplicationContext";
import { initializeInventoryInTransactionUseCase, setInventoryQuantityInTransactionUseCase } from "../../application/inventory";
import { slugify } from "../../validation/common";
import type { CreateProductInput, UpdateProductInput } from "../../validation/product";
import type { CreateCategoryInput, UpdateCategoryInput } from "../../validation/category";
import type { CreateCollectionInput, UpdateCollectionInput } from "../../validation/collection";

export interface ProductWriteUseCaseContext { unitOfWork: UnitOfWork; repositories: ProductWriteRepositoryBundle }
const now = () => new Date().toISOString();
const nullable = (v: unknown): string | number | boolean | null => v === undefined || v === null ? null : (typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : JSON.stringify(v));
function stock(type: ProductType, requested?: number) { if (type === ProductType.UniqueItem) { const q = requested ?? 1; if (q > 1) throw new BadRequestError("Unique Item stock quantity cannot exceed 1"); return q; } return requested ?? 1; }
function productValues(input: CreateProductInput | UpdateProductInput, extra: Record<string, unknown> = {}) { const out: Record<string, unknown> = { ...extra }; for (const [k,v] of Object.entries(input as Record<string, unknown>)) { if (k === "images" || k === "expectedUpdatedAt" || v === undefined) continue; out[k] = Array.isArray(v) ? JSON.stringify(v) : nullable(v); } return out as Record<string, string|number|boolean|null>; }
const chain = <T, U>(value: T | Promise<T>, next: (value: T) => U | Promise<U>) => value instanceof Promise ? value.then(next) : next(value);
export function createProductWithInventoryUseCase(ctx: InventoryApplicationContext, input: CreateProductInput) {
  const quantity = stock(input.type, input.stockQuantity);
  const slug = input.slug ? slugify(input.slug) : slugify(input.title);
  const t = now(), id = randomUUID();
  return chain(ctx.repositories.products.existsBySku(input.sku), (exists) => {
    if (exists) throw new ConflictError(`SKU "${input.sku}" is already in use`);
    return ctx.unitOfWork.run(({ repositories }) => chain(
      repositories.inventoryRepositories.products.create(productValues(input, {
        id, slug, createdAt: t, updatedAt: t,
      }) as never),
      () => input.stockQuantity === undefined ? { id } : chain(
        initializeInventoryInTransactionUseCase(ctx, repositories.inventoryRepositories, {
          productId: id, quantity, idempotencyKey: `product-create-stock:${id}`, note: "Product creation stock quantity",
        }),
        () => ({ id }),
      ),
    ));
  });
}

export function updateProductWithInventoryUseCase(
  ctx: InventoryApplicationContext,
  id: string,
  input: UpdateProductInput & { expectedUpdatedAt?: string },
) {
  return chain(ctx.repositories.products.findById(id), (current) => {
    if (!current) throw new NotFoundError("Product not found");
    return chain(input.sku ? ctx.repositories.products.existsBySku(input.sku, id) : false, (duplicate) => {
      if (duplicate) throw new ConflictError(`SKU "${input.sku}" is already in use`);
      const { stockQuantity, expectedUpdatedAt, ...metadata } = input;
      const values = productValues(metadata, { updatedAt: now(), ...(input.slug !== undefined ? { slug: slugify(input.slug) } : {}) });
      return ctx.unitOfWork.run(({ repositories }) => chain(
        repositories.inventoryRepositories.products.updateWithVersion(id, values as never, expectedUpdatedAt ?? current.updatedAt),
        (updated) => stockQuantity === undefined || stockQuantity === current.stockQuantity ? { id, updated: true } : chain(
          setInventoryQuantityInTransactionUseCase(ctx, repositories.inventoryRepositories, {
            productId: id, quantity: stockQuantity, expectedVersion: updated.updatedAt,
            idempotencyKey: `product-update-stock:${id}:${current.updatedAt}:${stockQuantity}`,
            note: "Product update stock quantity",
          }),
          () => ({ id, updated: true }),
        ),
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
export async function upsertProductErpMetadataUseCase(ctx: ProductWriteUseCaseContext, productId: string, metadata: Record<string, unknown>) { const clean = Object.fromEntries(Object.entries(metadata).filter(([,v]) => v !== undefined).map(([k,v]) => [k, nullable(v)])); if (!Object.keys(clean).length) return; if (clean.noctellaId && await ctx.repositories.products.existsByNoctellaId(String(clean.noctellaId), productId)) throw new ConflictError("noctellaId is already in use"); const t = now(); return ctx.unitOfWork.run(async () => { const existing = await ctx.repositories.products.getErpMetadataForUpdate(productId); if (existing) await ctx.repositories.products.updateErpMetadata(productId, { ...clean, updatedAt: t } as any); else await ctx.repositories.products.createErpMetadata({ productId, ...clean, createdAt: t, updatedAt: t } as any); }); }
