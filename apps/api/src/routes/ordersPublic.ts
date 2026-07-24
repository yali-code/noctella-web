import { Router } from "express";
import { db } from "../db/client";
import { createOrder } from "../services/orders";
import { createOrderSchema } from "../validation/order";
import { handleRouteError } from "./errorHandler";

/**
 * Sprint 64C: guest checkout order creation only - the exact route the storefront calls
 * directly with no admin session. Split out of orders.ts (which retains every administrative
 * order route) so this one route can be mounted before the admin session boundary without
 * making the rest of the order surface public. Reuses the same service/validation as the
 * administrative router - no duplicated business logic.
 */
const router = Router();

router.post("/", async (req, res) => {
  try {
    const input = createOrderSchema.parse(req.body);
    const order = await createOrder(db, input);
    res.status(201).json(order);
  } catch (err) {
    handleRouteError(err, res);
  }
});

export default router;
