import { Router } from "express";
import { db } from "../db/client";
import { createCashOnDeliveryOrder, createOrder, getShippingOptions } from "../services/orders";
import { createCashOnDeliveryOrderSchema, createOrderSchema } from "../validation/order";
import { shippingQuoteRequestSchema } from "../validation/shipping";
import { codOrderRateLimit } from "../middleware/codRateLimit";
import { handleRouteError } from "./errorHandler";
import { customerToken, requireCustomerOrigin } from "./customerAuth";
import { resolveCustomerSession } from "../services/customerIdentity";
import { eq } from "drizzle-orm";
import { orders } from "../db/schema";
import { ConflictError } from "../services/errors";

/**
 * Sprint 64C: guest checkout order creation only - the exact route the storefront calls
 * directly with no admin session. Split out of orders.ts (which retains every administrative
 * order route) so this one route can be mounted before the admin session boundary without
 * making the rest of the order surface public. Reuses the same service/validation as the
 * administrative router - no duplicated business logic.
 */
const router = Router();

async function assertDraftOwner(draftId: string, customerId: string | undefined) {
  const [existing] = await db.select({ customerId: orders.customerId }).from(orders).where(eq(orders.orderDraftId, draftId)).limit(1);
  if (existing && existing.customerId !== (customerId ?? null)) throw new ConflictError("Order draft is unavailable");
}
async function assertResultOwner(orderId: string, customerId: string | undefined) {
  const [created] = await db.select({ customerId: orders.customerId }).from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!created || created.customerId !== (customerId ?? null)) throw new ConflictError("Order draft is unavailable");
}

/** Sprint 134: public, non-mutating shipping-options quote - advisory only, see services/orders.ts::getShippingOptions. */
router.post("/shipping-options", async (req, res) => {
  try {
    const input = shippingQuoteRequestSchema.parse(req.body);
    res.json(await getShippingOptions(db, input));
  } catch (err) {
    handleRouteError(err, res);
  }
});

/** Sprint 135: narrow, route-specific abuse guard - see middleware/codRateLimit.ts. Does not apply to /shipping-options or / above. */
router.post("/cod", codOrderRateLimit, async (req, res) => {
  try {
    const input = createCashOnDeliveryOrderSchema.parse(req.body);
    const identity = await resolveCustomerSession(db, customerToken(req));
    if (identity) requireCustomerOrigin(req, res, () => undefined);
    if (res.headersSent) return;
    await assertDraftOwner(input.orderDraftId, identity?.customerId);
    const result = await createCashOnDeliveryOrder(db, { ...input, customerId: identity?.customerId });
    await assertResultOwner(result.id, identity?.customerId);
    res.status(201).json(result);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/", async (req, res) => {
  try {
    const input = createOrderSchema.parse(req.body);
    const identity = await resolveCustomerSession(db, customerToken(req));
    if (identity) requireCustomerOrigin(req, res, () => undefined);
    if (res.headersSent) return;
    await assertDraftOwner(input.orderDraftId, identity?.customerId);
    const order = await createOrder(db, { ...input, customerId: identity?.customerId }, { pricingContext: "noctella_web" });
    await assertResultOwner(order.id, identity?.customerId);
    res.status(201).json(order);
  } catch (err) {
    handleRouteError(err, res);
  }
});

export default router;
