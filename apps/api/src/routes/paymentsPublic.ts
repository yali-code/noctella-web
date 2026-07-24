import { Router } from "express";
import { db } from "../db/client";
import { cancelPaymentSession, initializePaymentSession, verifyPaymentSession } from "../payments/paymentRepository";
import { cancelPaymentSchema, initializePaymentSchema, verifyPaymentSchema } from "../validation/payment";
import { handleRouteError } from "./errorHandler";

/**
 * Sprint 64C: guest checkout payment routes only - the exact routes the storefront calls
 * directly with no admin session. Split out of payments.ts (which retains the administrative
 * listing route) so these can be mounted before the admin session boundary without making the
 * rest of the payments surface public. Reuses the same service/validation as the administrative
 * router - no duplicated business logic.
 */
const router = Router();

router.post("/initialize", async (req, res) => {
  try {
    const input = initializePaymentSchema.parse(req.body);
    const result = await initializePaymentSession(db, input);
    res.status(201).json(result);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/verify", async (req, res) => {
  try {
    const input = verifyPaymentSchema.parse(req.body);
    const result = await verifyPaymentSession(db, input);
    res.json(result);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/cancel", async (req, res) => {
  try {
    const input = cancelPaymentSchema.parse(req.body);
    const result = await cancelPaymentSession(db, input);
    res.json(result);
  } catch (err) {
    handleRouteError(err, res);
  }
});

export default router;
