import { ProductStatus, StockMovementType } from "@noctella/shared";
import type { InventoryApplicationContext } from "../../services/inventoryApplicationContext";
import {
  createInventoryEvent,
  type InventoryEvent,
  type InventoryEventName,
} from "../../domain/inventory";
import { emitInventorySignal } from "../../observability/inventory";
import {
  DuplicateSkuError,
  DuplicateStockLocationCodeError,
  InsufficientStockError,
  InventoryNotFoundError,
  ProductNotFoundError,
  StaleInventoryVersionError,
  StaleProductVersionError,
  StockLocationNotFoundError,
} from "../../repositories/inventory/errors";
import type {
  InventoryState,
  ProductRecord,
  StockLocationRecord,
  StockMovementRecord,
} from "../../repositories/inventory/types";
import {
  InsufficientInventoryError,
  InvalidInventoryQuantityError,
  InvalidSkuError,
  InventoryAlreadyInitializedError,
  InventoryNotInitializedError,
  InventoryOperationConflictError,
  InventoryVersionConflictError,
  ProductAlreadyExistsError,
  ProductNotFoundApplicationError,
  StockLocationNotFoundApplicationError,
} from "./errors";
import type {
  CreateProductInput,
  CreateStockLocationInput,
  GetStockLocationInput,
  InitializeInventoryInput,
  InventoryDto,
  InventoryMutationInput,
  ListStockLocationsInput,
  ProductDto,
  ProductIdInput,
  ProductSkuInput,
  SetInventoryQuantityInput,
  StockLocationDto,
  StockMovementDto,
  UpdateProductInput,
} from "./types";

const skuOk = (sku: string) => /^[A-Z0-9][A-Z0-9._-]{1,63}$/.test(sku);
const positive = (n: number) => Number.isInteger(n) && n > 0;
const nonneg = (n: number) => Number.isInteger(n) && n >= 0;
const ro = <T extends object>(x: T): Readonly<T> => Object.freeze({ ...x });
const chain = <T, U>(value: T | Promise<T>, next: (value: T) => U | Promise<U>) =>
  value instanceof Promise ? value.then(next) : next(value);
type InventoryMutationRepositories = InventoryApplicationContext["repositories"];
const product = (p: ProductRecord): ProductDto =>
  Object.freeze({
    ...p,
    purchaseCurrency: "EUR",
    marketplace: Object.freeze({ ...p.marketplace }),
  });
const inv = (i: InventoryState): InventoryDto => ro(i);
const movement = (m: StockMovementRecord): StockMovementDto => ro(m);
const location = (l: StockLocationRecord): StockLocationDto => ro(l);
function map(e: unknown): never {
  if (e instanceof DuplicateSkuError) throw new ProductAlreadyExistsError();
  if (e instanceof ProductNotFoundError)
    throw new ProductNotFoundApplicationError();
  if (
    e instanceof StaleProductVersionError ||
    e instanceof StaleInventoryVersionError
  )
    throw new InventoryVersionConflictError();
  if (e instanceof InventoryNotFoundError)
    throw new InventoryNotInitializedError();
  if (e instanceof InsufficientStockError)
    throw new InsufficientInventoryError();
  if (e instanceof StockLocationNotFoundError)
    throw new StockLocationNotFoundApplicationError();
  if (e instanceof DuplicateStockLocationCodeError)
    throw new InventoryOperationConflictError();
  throw e;
}
const same = (
  m: StockMovementRecord,
  input: {
    productId: string;
    quantity: number;
    type: string;
    note?: string | null;
    orderId?: string | null;
    orderItemId?: string | null;
  },
) =>
  m.productId === input.productId &&
  m.quantityDelta === input.quantity &&
  m.type === input.type &&
  (m.note ?? null) === (input.note ?? null) &&
  (m.orderId ?? null) === (input.orderId ?? null) &&
  (m.orderItemId ?? null) === (input.orderItemId ?? null);
async function replay(
  ctx: InventoryApplicationContext,
  input: {
    idempotencyKey?: string;
    productId: string;
    quantity: number;
    type: string;
    note?: string | null;
    orderId?: string | null;
    orderItemId?: string | null;
  },
) {
  if (!input.idempotencyKey) return null;
  const m = await ctx.stockMovementRepository.findByIdempotencyKey(
    input.idempotencyKey,
  );
  if (!m) return null;
  if (!same(m, input)) throw new InventoryOperationConflictError();
  await emitInventorySignal(
    ctx.observability,
    "inventoryIdempotentReplayDetected",
    { aggregateId: input.productId, idempotencyKey: input.idempotencyKey },
    ctx.logger,
  );
  const current = await ctx.inventoryRepository.findByProduct(input.productId);
  if (!current) throw new InventoryNotInitializedError();
  return inv(current);
}
function now(ctx: InventoryApplicationContext) {
  return ctx.clock.now().toISOString();
}
async function publish(
  ctx: InventoryApplicationContext,
  event: InventoryEvent,
) {
  try {
    await ctx.eventPublisher.publish(event);
    await emitInventorySignal(
      ctx.observability,
      "inventoryEventPublished",
      event,
      ctx.logger,
    );
  } catch (e) {
    await emitInventorySignal(
      ctx.observability,
      "inventoryEventPublicationFailed",
      {
        eventId: event.id,
        eventName: event.name,
        aggregateId: event.aggregateId,
        error: e instanceof Error ? e.message : "publication failed",
      },
      ctx.logger,
    );
    ctx.logger.warn?.("inventory event publication failed", {
      eventId: event.id,
      eventName: event.name,
      aggregateId: event.aggregateId,
    });
  }
}
function event(
  ctx: InventoryApplicationContext,
  name: InventoryEventName,
  aggregateType: InventoryEvent["aggregateType"],
  aggregateId: string,
  payload: InventoryEvent["payload"],
  occurredAt: string,
) {
  return createInventoryEvent({
    id: ctx.idGenerator.newId(),
    name,
    occurredAt,
    aggregateId,
    aggregateType,
    payload,
  });
}
export const createGetProductUseCase = (ctx: InventoryApplicationContext) => ({
  execute: async ({ productId }: ProductIdInput) => {
    const p = await ctx.productRepository.findById(productId);
    if (!p) throw new ProductNotFoundApplicationError();
    return product(p);
  },
});
export const createGetProductBySkuUseCase = (
  ctx: InventoryApplicationContext,
) => ({
  execute: async ({ sku }: ProductSkuInput) => {
    const p = await ctx.productRepository.findBySku(sku);
    if (!p) throw new ProductNotFoundApplicationError();
    return product(p);
  },
});
export const createListProductsUseCase = (
  ctx: InventoryApplicationContext,
) => ({
  execute: async () => (await ctx.productRepository.list()).map(product),
});
export const createGetInventoryUseCase = (
  ctx: InventoryApplicationContext,
) => ({
  execute: async ({ productId }: ProductIdInput) => {
    const i = await ctx.inventoryRepository.findByProduct(productId);
    if (!i) throw new InventoryNotInitializedError();
    return inv(i);
  },
});
export const createListInventoryByProductUseCase = (
  ctx: InventoryApplicationContext,
) => ({
  execute: async ({ productId }: ProductIdInput) =>
    (await ctx.inventoryRepository.listByProduct(productId)).map(inv),
});
export const createListStockMovementsUseCase = (
  ctx: InventoryApplicationContext,
) => ({
  execute: async ({ productId }: ProductIdInput) =>
    (await ctx.stockMovementRepository.listByProduct(productId)).map(movement),
});
export const createGetStockLocationUseCase = (
  ctx: InventoryApplicationContext,
) => ({
  execute: async ({ id }: GetStockLocationInput) => {
    const l = await ctx.stockLocationRepository.findById(id);
    if (!l) throw new StockLocationNotFoundApplicationError();
    return location(l);
  },
});
export const createListStockLocationsUseCase = (
  ctx: InventoryApplicationContext,
) => ({
  execute: async (input: ListStockLocationsInput = {}) =>
    (await ctx.stockLocationRepository.list(input.warehouseId)).map(location),
});
export const createProductUseCase = (ctx: InventoryApplicationContext) => ({
  execute: async (input: CreateProductInput) => {
    if (!skuOk(input.sku)) throw new InvalidSkuError();
    if (input.purchaseCurrency && input.purchaseCurrency !== "EUR")
      throw new InvalidInventoryQuantityError("Only EUR is supported");
    if (!nonneg(input.stockQuantity ?? 1))
      throw new InvalidInventoryQuantityError();
    if (await ctx.productRepository.existsBySku(input.sku))
      throw new ProductAlreadyExistsError();
    const t = now(ctx),
      id = ctx.idGenerator.newId();
    try {
      const out = await ctx.unitOfWork.run(({ repositories }) =>
        chain(repositories.inventoryRepositories.products.create({
            ...input,
            id,
            createdAt: t,
            updatedAt: t,
            status: input.status ?? ProductStatus.Draft,
            purchaseCurrency: "EUR",
          }), product),
      );
      await publish(
        ctx,
        event(
          ctx,
          "inventory.product.created",
          "product",
          out.id,
          { productId: out.id, sku: out.sku },
          t,
        ),
      );
      return out;
    } catch (e) {
      map(e);
    }
  },
});
export const createUpdateProductUseCase = (
  ctx: InventoryApplicationContext,
) => ({
  execute: async (input: UpdateProductInput) => {
    if (input.sku && !skuOk(input.sku)) throw new InvalidSkuError();
    if (input.purchaseCurrency && input.purchaseCurrency !== "EUR")
      throw new InvalidInventoryQuantityError("Only EUR is supported");
    const { id, expectedVersion, ...patch } = input;
    try {
      const t = now(ctx);
      const out = await ctx.unitOfWork.run(({ repositories }) =>
        chain(repositories.inventoryRepositories.products.updateWithVersion(
            id,
            { ...patch, updatedAt: t },
            expectedVersion,
          ), product),
      );
      await publish(
        ctx,
        event(
          ctx,
          "inventory.product.updated",
          "product",
          out.id,
          { productId: out.id, sku: out.sku },
          t,
        ),
      );
      return out;
    } catch (e) {
      map(e);
    }
  },
});
export const createInitializeInventoryUseCase = (
  ctx: InventoryApplicationContext,
) => ({
  execute: async (input: InitializeInventoryInput) => {
    if (!nonneg(input.quantity)) throw new InvalidInventoryQuantityError();
    const rep = await replay(ctx, {
      ...input,
      type: StockMovementType.ManualAdjustment,
      quantity: input.quantity,
    });
    if (rep) return rep;
    try {
      let meta: { before: number; after: number; time: string };
      const out = await ctx.unitOfWork.run(({ repositories }) =>
        chain(repositories.inventoryRepositories.products.findById(input.productId), (p) => {
          if (!p) throw new ProductNotFoundApplicationError();
          if (p.stockQuantity !== 1 && p.stockQuantity !== input.quantity)
            throw new InventoryAlreadyInitializedError();
          const t = now(ctx);
          const mutation = input.expectedVersion
            ? repositories.inventoryRepositories.inventory.updateWithVersion(input.productId, input.quantity, input.expectedVersion, t)
            : repositories.inventoryRepositories.inventory.create({ productId: input.productId, quantity: input.quantity, updatedAt: t });
          return chain(mutation, (state) => chain(
            repositories.inventoryRepositories.stockMovements.append({
              id: ctx.idGenerator.newId(), productId: input.productId,
              type: StockMovementType.ManualAdjustment, quantityDelta: input.quantity,
              stockBefore: p.stockQuantity, stockAfter: input.quantity,
              orderId: null, orderItemId: null, note: input.note ?? null,
              idempotencyKey: input.idempotencyKey ?? null, createdAt: t, updatedAt: t,
            }),
            () => {
              meta = { before: p.stockQuantity, after: input.quantity, time: t };
              return inv(state);
            },
          ));
        }),
      );
      await publish(
        ctx,
        event(
          ctx,
          "inventory.stock.initialized",
          "inventory",
          input.productId,
          {
            productId: input.productId,
            movementType: StockMovementType.ManualAdjustment,
            quantityDelta: input.quantity,
            stockBefore: meta!.before,
            stockAfter: meta!.after,
            idempotencyKey: input.idempotencyKey ?? null,
          },
          meta!.time,
        ),
      );
      return out;
    } catch (e) {
      map(e);
    }
  },
});
async function change(
  ctx: InventoryApplicationContext,
  input: InventoryMutationInput,
  sign: 1 | -1,
) {
  if (!positive(input.quantity)) throw new InvalidInventoryQuantityError();
  const q = sign * input.quantity;
  const type =
    sign > 0 ? StockMovementType.PurchaseReceipt : StockMovementType.Sale;
  const rep = await replay(ctx, { ...input, type, quantity: q });
  if (rep) return rep;
  try {
    let meta: { before: number; after: number; time: string };
    const out = await ctx.unitOfWork.run(({ repositories }) =>
      chain(
        repositories.inventoryRepositories.inventory.findByProduct(input.productId),
        (cur) => {
          if (!cur) throw new InventoryNotInitializedError();
          const next = cur.quantity + q;
          if (next < 0) throw new InsufficientInventoryError();
          const t = now(ctx);
          return chain(
            repositories.inventoryRepositories.inventory.updateWithVersion(
              input.productId, next, input.expectedVersion, t,
            ),
            (state) => chain(
              repositories.inventoryRepositories.stockMovements.append({
                id: ctx.idGenerator.newId(), productId: input.productId, type,
                quantityDelta: q, stockBefore: cur.quantity, stockAfter: next,
                orderId: input.orderId ?? null, orderItemId: input.orderItemId ?? null,
                note: input.note ?? null, idempotencyKey: input.idempotencyKey ?? null,
                createdAt: t, updatedAt: t,
              }),
              () => {
                meta = { before: cur.quantity, after: next, time: t };
                return inv(state);
              },
            ),
          );
        },
      ),
    );
    await publish(
      ctx,
      event(
        ctx,
        sign > 0 ? "inventory.stock.increased" : "inventory.stock.decreased",
        "inventory",
        input.productId,
        {
          productId: input.productId,
          movementType: type,
          quantityDelta: q,
          stockBefore: meta!.before,
          stockAfter: meta!.after,
          idempotencyKey: input.idempotencyKey ?? null,
        },
        meta!.time,
      ),
    );
    return out;
  } catch (e) {
    map(e);
  }
}
function mutateInventoryInTransactionUseCase(
  ctx: Pick<InventoryApplicationContext, "clock" | "idGenerator">,
  repositories: InventoryMutationRepositories,
  input: Omit<InventoryMutationInput, "expectedVersion"> & { expectedVersion?: string },
  quantityDelta: number,
  type: StockMovementType,
) {
  if (!positive(input.quantity)) throw new InvalidInventoryQuantityError();
  const key = input.idempotencyKey;
  try {
    const existing = key && typeof repositories.stockMovements.findByIdempotencyKey === "function"
      ? repositories.stockMovements.findByIdempotencyKey(key)
      : null;
    const result = chain(existing, (found) => {
      if (found) {
        if (!same(found, { ...input, type, quantity: quantityDelta }))
          throw new InventoryOperationConflictError();
        return chain(repositories.inventory.findByProduct(input.productId), (current) => {
          if (!current) throw new InventoryNotInitializedError();
          return Object.freeze({ inventory: inv(current), movement: movement(found), replayed: true });
        });
      }
      return chain(repositories.inventory.findByProduct(input.productId), (current) => {
        if (!current) throw new InventoryNotInitializedError();
        const stockAfter = current.quantity + quantityDelta;
        if (stockAfter < 0) throw new InsufficientInventoryError();
        const t = now(ctx as InventoryApplicationContext);
        return chain(
          repositories.inventory.updateWithVersion(input.productId, stockAfter, input.expectedVersion ?? current.updatedAt, t),
          (state) => {
            const append = () => chain(repositories.stockMovements.append({
              id: ctx.idGenerator.newId(), productId: input.productId, type,
              quantityDelta, stockBefore: current.quantity, stockAfter,
              orderId: input.orderId ?? null, orderItemId: input.orderItemId ?? null,
              note: input.note ?? null, idempotencyKey: key ?? null, createdAt: t, updatedAt: t,
            }),
            (created) => Object.freeze({ inventory: inv(state), movement: movement(created), replayed: false }));
            return type === StockMovementType.Sale && stockAfter === 0
              ? chain(repositories.products.update(input.productId, { status: ProductStatus.Sold, updatedAt: t }), append)
              : append();
          },
        );
      });
    });
    return result instanceof Promise ? result.catch(map) : result;
  } catch (e) {
    map(e);
  }
}
export function increaseInventoryInTransactionUseCase(
  ctx: Pick<InventoryApplicationContext, "clock" | "idGenerator">,
  repositories: InventoryMutationRepositories,
  input: Omit<InventoryMutationInput, "expectedVersion"> & { expectedVersion?: string },
) {
  return mutateInventoryInTransactionUseCase(ctx, repositories, input, input.quantity, StockMovementType.PurchaseReceipt);
}
export function decreaseInventoryForSaleInTransactionUseCase(
  ctx: Pick<InventoryApplicationContext, "clock" | "idGenerator">,
  repositories: InventoryMutationRepositories,
  input: Omit<InventoryMutationInput, "expectedVersion"> & { expectedVersion?: string },
) {
  return mutateInventoryInTransactionUseCase(ctx, repositories, input, -input.quantity, StockMovementType.Sale);
}
export function restoreInventoryForSaleRollbackInTransactionUseCase(
  ctx: Pick<InventoryApplicationContext, "clock" | "idGenerator">,
  repositories: InventoryMutationRepositories,
  input: Omit<InventoryMutationInput, "expectedVersion"> & { expectedVersion?: string },
) {
  return mutateInventoryInTransactionUseCase(ctx, repositories, input, input.quantity, StockMovementType.SaleRollback);
}
export const createIncreaseInventoryUseCase = (
  ctx: InventoryApplicationContext,
) => ({ execute: (input: InventoryMutationInput) => change(ctx, input, 1) });
export const createDecreaseInventoryUseCase = (
  ctx: InventoryApplicationContext,
) => ({ execute: (input: InventoryMutationInput) => change(ctx, input, -1) });
export const createSetInventoryQuantityUseCase = (
  ctx: InventoryApplicationContext,
) => ({
  execute: async (input: SetInventoryQuantityInput) => {
    if (!nonneg(input.quantity)) throw new InvalidInventoryQuantityError();
    if (!input.note.trim()) throw new InventoryOperationConflictError();
    const cur0 = await ctx.inventoryRepository.findByProduct(input.productId);
    const delta = cur0 ? input.quantity - cur0.quantity : input.quantity;
    const rep = await replay(ctx, {
      ...input,
      type: StockMovementType.ManualAdjustment,
      quantity: delta,
    });
    if (rep) return rep;
    try {
      let meta: { before: number; after: number; delta: number; time: string };
      const out = await ctx.unitOfWork.run(({ repositories }) =>
        chain(repositories.inventoryRepositories.inventory.findByProduct(input.productId), (cur) => {
          if (!cur) throw new InventoryNotInitializedError();
          const t = now(ctx);
          return chain(
            repositories.inventoryRepositories.inventory.updateWithVersion(input.productId, input.quantity, input.expectedVersion, t),
            (state) => chain(
              repositories.inventoryRepositories.stockMovements.append({
                id: ctx.idGenerator.newId(), productId: input.productId,
                type: StockMovementType.ManualAdjustment,
                quantityDelta: input.quantity - cur.quantity, stockBefore: cur.quantity,
                stockAfter: input.quantity, orderId: null, orderItemId: null,
                note: input.note, idempotencyKey: input.idempotencyKey ?? null,
                createdAt: t, updatedAt: t,
              }),
              () => {
                meta = { before: cur.quantity, after: input.quantity, delta: input.quantity - cur.quantity, time: t };
                return inv(state);
              },
            ),
          );
        }),
      );
      await publish(
        ctx,
        event(
          ctx,
          "inventory.stock.quantity_set",
          "inventory",
          input.productId,
          {
            productId: input.productId,
            movementType: StockMovementType.ManualAdjustment,
            quantityDelta: meta!.delta,
            stockBefore: meta!.before,
            stockAfter: meta!.after,
            idempotencyKey: input.idempotencyKey ?? null,
          },
          meta!.time,
        ),
      );
      return out;
    } catch (e) {
      map(e);
    }
  },
});
export const createStockLocationUseCase = (
  ctx: InventoryApplicationContext,
) => ({
  execute: async (input: CreateStockLocationInput) => {
    try {
      const t = now(ctx),
        id = ctx.idGenerator.newId();
      const out = await ctx.unitOfWork.run(({ repositories }) =>
        chain(repositories.inventoryRepositories.stockLocations.create({
            id,
            ...input,
            createdAt: t,
            updatedAt: t,
          }), location),
      );
      await publish(
        ctx,
        event(
          ctx,
          "inventory.stock_location.created",
          "stock_location",
          out.id,
          { stockLocationId: out.id },
          t,
        ),
      );
      return out;
    } catch (e) {
      map(e);
    }
  },
});
