import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { type Offer, OfferStatus, ProductStatus } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { offers, products } from "../db/schema";
import { BadRequestError, NotFoundError } from "./errors";
import type { CreateOfferInput } from "../validation/offer";
import { SqliteUnitOfWork } from "./unitOfWork";
import { createDraftOrderFromOfferUseCase } from "../use-cases/order/useCases";
import type { OrderDetailProjection } from "../repositories/order/types";

function toOffer(row: typeof offers.$inferSelect): Offer {
  return {
    id: row.id,
    productId: row.productId,
    customerName: row.customerName,
    customerEmail: row.customerEmail,
    offeredAmount: row.offeredAmount,
    currency: row.currency as Offer["currency"],
    message: row.message ?? undefined,
    status: row.status as OfferStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getOfferById(db: DbClient, id: string): Promise<Offer> {
  const [row] = await db.select().from(offers).where(eq(offers.id, id));
  if (!row) throw new NotFoundError("Offer not found");
  return toOffer(row);
}

export async function listOffers(db: DbClient): Promise<Offer[]> {
  const rows = await db.select().from(offers).orderBy(desc(offers.createdAt));
  return rows.map(toOffer);
}

/**
 * Accept/reject only change the offer's own status. Pending is the only
 * state either transition may start from; Accepted and Rejected are
 * terminal. Never touches products, inventory, orders, or payments.
 */
async function transitionOffer(db: DbClient, id: string, to: OfferStatus): Promise<Offer> {
  const offer = await getOfferById(db, id);
  if (offer.status !== OfferStatus.Pending) {
    throw new BadRequestError("Invalid offer status transition");
  }
  await db
    .update(offers)
    .set({ status: to, updatedAt: new Date().toISOString() })
    .where(eq(offers.id, id));
  return getOfferById(db, id);
}

export async function acceptOffer(db: DbClient, id: string): Promise<Offer> {
  return transitionOffer(db, id, OfferStatus.Accepted);
}

export async function rejectOffer(db: DbClient, id: string): Promise<Offer> {
  return transitionOffer(db, id, OfferStatus.Rejected);
}

/**
 * Creating a Draft Order is an explicit admin action, never an automatic
 * consequence of accepting an offer. Only Accepted offers are eligible;
 * the order/offer link and duplicate-prevention are enforced by
 * createDraftOrderFromOfferUseCase.
 */
export async function createDraftOrderFromOffer(db: DbClient, id: string): Promise<OrderDetailProjection> {
  const offer = await getOfferById(db, id);
  if (offer.status !== OfferStatus.Accepted) {
    throw new BadRequestError("Only accepted offers can create a draft order");
  }
  return createDraftOrderFromOfferUseCase(new SqliteUnitOfWork(db)).execute({
    offerId: offer.id,
    productId: offer.productId,
    customerName: offer.customerName,
    customerEmail: offer.customerEmail,
    offeredAmount: offer.offeredAmount,
    currency: offer.currency,
  });
}

/**
 * Creates a "Make an Offer" record (Sprint 4 rules): product must be
 * Published and have allowMakeOffer enabled, amount must be positive.
 * Never reserves the product, never touches stock or price, and the
 * offer always starts Pending — never auto-accepted.
 */
export async function createOffer(db: DbClient, input: CreateOfferInput): Promise<Offer> {
  const [product] = await db.select().from(products).where(eq(products.id, input.productId));
  if (!product) throw new NotFoundError("Product not found");

  if (product.status !== ProductStatus.Published) {
    throw new BadRequestError("Offers can only be made on published products");
  }
  if (!product.allowMakeOffer) {
    throw new BadRequestError("This product does not accept offers");
  }

  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(offers).values({
    id,
    productId: input.productId,
    customerName: input.customerName,
    customerEmail: input.customerEmail,
    offeredAmount: input.offeredAmount,
    currency: input.currency,
    message: input.message,
    status: OfferStatus.Pending,
    createdAt: now,
    updatedAt: now,
  });

  // Deliberately no writes to `products` here — creating an offer must
  // never reserve the item, change stock, or change price.
  return getOfferById(db, id);
}
