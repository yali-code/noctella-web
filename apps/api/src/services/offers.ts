import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { type Offer, OfferStatus, ProductStatus } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { offers, products } from "../db/schema";
import { BadRequestError, NotFoundError } from "./errors";
import type { CreateOfferInput } from "../validation/offer";

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
