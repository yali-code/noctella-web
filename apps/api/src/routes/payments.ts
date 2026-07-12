import { Router } from "express";
import { cancelMockPayment, initializeMockPayment, verifyMockPayment } from "../payments/paymentService";
import { cancelPaymentSchema, initializePaymentSchema, verifyPaymentSchema } from "../validation/payment";
import { handleRouteError } from "./errorHandler";

/**
 * Sprint 6A: payment foundation. Mock providers only — no real Stripe/
 * PayPal/CashOnDelivery integration, no payment sessions, no persistence.
 */
const router = Router();

router.post("/initialize", async (req, res) => {
  try {
    const input = initializePaymentSchema.parse(req.body);
    const result = await initializeMockPayment(input.provider, input);
    res.status(201).json(result);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/verify", async (req, res) => {
  try {
    const input = verifyPaymentSchema.parse(req.body);
    const result = await verifyMockPayment(input.provider, input);
    res.json(result);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/cancel", async (req, res) => {
  try {
    const input = cancelPaymentSchema.parse(req.body);
    const result = await cancelMockPayment(input.provider, input);
    res.json(result);
  } catch (err) {
    handleRouteError(err, res);
  }
});

export default router;
