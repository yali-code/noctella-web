import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, like, or, sql } from "drizzle-orm";
import {
  type Address,
  type Order,
  type OrderItem,
  OrderStatus,
  PaymentStatus,
  PriceCurrency,
  ProductStatus,
} from "@noctella/shared";
import type { DbClient } from "../db/client";
import { orderItems, orders, productImages, products } from "../db/schema";
import { BadRequestError, NotFoundError } from "./errors";
import type { CreateOrderInput, OrderListQuery, UpdateOrderStatusInput } from "../validation/order";

export interface OrderWithItems extends Order {
  items: OrderItem[];
}

function parseAddress(value: string): Address {
  return JSON.parse(value) as Address;
}

function toOrder(row: typeof orders.$inferSelect): Order {
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    orderDraftId: row.orderDraftId ?? undefined,
    customerId: row.customerId ?? undefined,
    guestEmail: row.guestEmail,
    status: row.status as OrderStatus,
    paymentStatus: row.paymentStatus as PaymentStatus,
    paymentProvider: (row.paymentProvider as Order["paymentProvider"]) ?? undefined,
    paymentReference: row.paymentReference ?? undefined,
    subtotalAmount: row.subtotalAmount,
    shippingAmount: row.shippingAmount,
    taxAmount: row.taxAmount,
    totalAmount: row.totalAmount,
    currency: row.currency as Order["currency"],
    billingAddress: parseAddress(row.billingAddress),
    shippingAddress: parseAddress(row.shippingAddress),
    notes: row.notes ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toOrderItem(row: typeof orderItems.$inferSelect): OrderItem {
  return {
    id: row.id,
    orderId: row.orderId,
    productId: row.productId,
    productSku: row.productSku,
    productTitle: row.productTitle,
    productSlug: row.productSlug,
    productType: row.productType as OrderItem["productType"],
    productImageUrl: row.productImageUrl ?? undefined,
    quantity: 1,
    unitPrice: row.unitPrice,
    totalPrice: row.totalPrice,
    currency: row.currency as OrderItem["currency"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function formatOrderNumber(date = new Date(), sequence = Math.floor(Math.random() * 1_000_000)): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `NOC-${yyyy}${mm}${dd}-${String(sequence).padStart(6, "0")}`;
}

async function generateOrderNumber(db: DbClient): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const orderNumber = formatOrderNumber();
    const [existing] = await db.select({ id: orders.id }).from(orders).where(eq(orders.orderNumber, orderNumber));
    if (!existing) return orderNumber;
  }
  throw new BadRequestError("Could not generate a unique order number");
}

async function hydrateOrder(db: DbClient, row: typeof orders.$inferSelect): Promise<OrderWithItems> {
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, row.id));
  return { ...toOrder(row), items: items.map(toOrderItem) };
}

export async function getOrderById(db: DbClient, id: string): Promise<OrderWithItems> {
  const [row] = await db.select().from(orders).where(eq(orders.id, id));
  if (!row) throw new NotFoundError("Order not found");
  return hydrateOrder(db, row);
}

export async function getOrderByOrderNumber(db: DbClient, orderNumber: string): Promise<OrderWithItems> {
  const [row] = await db.select().from(orders).where(eq(orders.orderNumber, orderNumber));
  if (!row) throw new NotFoundError("Order not found");
  return hydrateOrder(db, row);
}

async function getPrimaryImageUrl(db: DbClient, productId: string): Promise<string | undefined> {
  const [primary] = await db
    .select({ url: productImages.url })
    .from(productImages)
    .where(and(eq(productImages.productId, productId), eq(productImages.isPrimary, true)))
    .orderBy(asc(productImages.sortOrder));
  return primary?.url;
}

export async function createOrder(db: DbClient, input: CreateOrderInput): Promise<OrderWithItems> {
  const [existing] = await db.select().from(orders).where(eq(orders.orderDraftId, input.orderDraftId));
  if (existing) return hydrateOrder(db, existing);

  if (input.paymentStatus !== PaymentStatus.Paid) {
    throw new BadRequestError("Orders can only be created from paid payments");
  }
  if (!input.paymentReference.trim()) {
    throw new BadRequestError("Payment reference is required");
  }
  if (input.currency !== PriceCurrency.Eur) {
    throw new BadRequestError("Only EUR orders are supported for now");
  }

  const snapshots = [];
  for (const item of input.items) {
    if (item.quantity !== 1) throw new BadRequestError("Order item quantity must be 1");
    const [product] = await db.select().from(products).where(eq(products.id, item.productId));
    if (!product) throw new NotFoundError("Product not found");
    if (product.status !== ProductStatus.Published) {
      throw new BadRequestError("Orders can only include published products");
    }
    snapshots.push({ product, imageUrl: await getPrimaryImageUrl(db, product.id) });
  }

  const subtotalAmount = snapshots.reduce((sum, snapshot) => sum + snapshot.product.priceEur, 0);
  if (input.subtotalAmount !== subtotalAmount || input.totalAmount !== subtotalAmount) {
    throw new BadRequestError("Submitted totals do not match current product prices");
  }

  const now = new Date().toISOString();
  const id = randomUUID();

  await db.insert(orders).values({
    id,
    orderNumber: await generateOrderNumber(db),
    orderDraftId: input.orderDraftId,
    customerId: input.customerId,
    guestEmail: input.guestEmail,
    status: input.status,
    paymentStatus: input.paymentStatus,
    paymentProvider: input.paymentProvider,
    paymentReference: input.paymentReference,
    subtotalAmount,
    shippingAmount: 0,
    taxAmount: 0,
    totalAmount: subtotalAmount,
    currency: input.currency,
    billingAddress: JSON.stringify(input.billingAddress),
    shippingAddress: JSON.stringify(input.shippingAddress),
    notes: input.notes,
    createdAt: now,
    updatedAt: now,
  });

  for (const snapshot of snapshots) {
    await db.insert(orderItems).values({
      id: randomUUID(),
      orderId: id,
      productId: snapshot.product.id,
      productSku: snapshot.product.sku,
      productTitle: snapshot.product.title,
      productSlug: snapshot.product.slug,
      productType: snapshot.product.type,
      productImageUrl: snapshot.imageUrl,
      quantity: 1,
      unitPrice: snapshot.product.priceEur,
      totalPrice: snapshot.product.priceEur,
      currency: input.currency,
      createdAt: now,
      updatedAt: now,
    });
  }

  return getOrderById(db, id);
}

export async function updateOrderStatus(
  db: DbClient,
  id: string,
  input: UpdateOrderStatusInput,
): Promise<OrderWithItems> {
  await getOrderById(db, id);
  await db
    .update(orders)
    .set({ status: input.status, updatedAt: new Date().toISOString() })
    .where(eq(orders.id, id));
  return getOrderById(db, id);
}

export async function listOrders(db: DbClient, query: OrderListQuery) {
  const filters = [];
  if (query.status) filters.push(eq(orders.status, query.status));
  if (query.paymentStatus) filters.push(eq(orders.paymentStatus, query.paymentStatus));
  if (query.search) {
    const term = `%${query.search}%`;
    filters.push(or(like(orders.orderNumber, term), like(orders.guestEmail, term))!);
  }

  const where = filters.length ? and(...filters) : undefined;
  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(orders).where(where);
  const rows = await db
    .select()
    .from(orders)
    .where(where)
    .orderBy(desc(orders.createdAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  return {
    data: await Promise.all(rows.map((row) => hydrateOrder(db, row))),
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      total: Number(count),
      totalPages: Math.ceil(Number(count) / query.pageSize),
    },
  };
}

export const searchOrders = listOrders;
