import { Router } from "express";
import { db } from "../db/client";
import { createCashOnDeliveryOrder, createOrder, getShippingOptions } from "../services/orders";
import { createCashOnDeliveryOrderSchema, createOrderSchema } from "../validation/order";
import { shippingQuoteRequestSchema } from "../validation/shipping";
import { codOrderRateLimit } from "../middleware/codRateLimit";
import { handleRouteError } from "./errorHandler";

/**
 * Sprint 64C: guest checkout order creation only - the exact route the storefront calls
 * directly with no admin session. Split out of orders.ts (which retains every administrative
 * order route) so this one route can be mounted before the admin session boundary without
 * making the rest of the order surface public. Reuses the same service/validation as the
 * administrative router - no duplicated business logic.
 */
const router = Router();

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
    res.status(201).json(await createCashOnDeliveryOrder(db, input));
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/", async (req, res) => {
  try {
    const input = createOrderSchema.parse(req.body);
    const order = await createOrder(db, input, { pricingContext: "noctella_web" });
    res.status(201).json(order);
  } catch (err) {
    handleRouteError(err, res);
  }
});

export default router;
