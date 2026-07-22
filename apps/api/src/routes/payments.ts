import { Router } from "express";
import { db } from "../db/client";
import { cancelPaymentSession, initializePaymentSession, listPayments, verifyPaymentSession } from "../payments/paymentRepository";
import { cancelPaymentSchema, initializePaymentSchema, listPaymentsQuerySchema, verifyPaymentSchema } from "../validation/payment";
import { handleRouteError } from "./errorHandler";

/**
 * Sprint 6A shipped mock-only initialize/verify/cancel. Sprint 37A added
 * server-side persistence of the payment session around those same mock
 * provider calls. Sprint 37B adds a read-only admin listing over that same
 * persisted data — still no real Stripe/PayPal/CashOnDelivery integration.
 */
const router = Router();

router.get("/", async (req, res) => {
  try {
    const query = listPaymentsQuerySchema.parse(req.query);
    const items = await listPayments(db, query);
    res.json(
      items.map((p) => ({
        id: p.id,
        provider: p.provider,
        providerReference: p.providerReference,
        status: p.status,
        amount: p.amount,
        currency: p.currency,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        orderId: p.orderId,
      })),
    );
  } catch (err) {
    handleRouteError(err, res);
  }
});

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
