import { Router } from "express";
import { requirePermission } from "../auth/permissions";
import { db } from "../db/client";
import { listPayments } from "../payments/paymentRepository";
import { listPaymentsQuerySchema } from "../validation/payment";
import { handleRouteError } from "./errorHandler";

/**
 * Sprint 6A shipped mock-only initialize/verify/cancel. Sprint 37A added
 * server-side persistence of the payment session around those same mock
 * provider calls. Sprint 37B adds a read-only admin listing over that same
 * persisted data — still no real Stripe/PayPal/CashOnDelivery integration.
 * Sprint 64C: initialize/verify/cancel (guest checkout, no admin session) moved to
 * routes/paymentsPublic.ts, mounted before the admin session boundary - this router now
 * covers the administrative read-only listing only.
 */
const router = Router();

router.get("/", requirePermission("orders.view"), async (req, res) => {
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

export default router;
