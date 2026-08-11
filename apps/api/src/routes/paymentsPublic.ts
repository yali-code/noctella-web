import { Router } from "express";
import { db } from "../db/client";
import { cancelPaymentSession, initializePaymentSession, verifyPaymentSession } from "../payments/paymentRepository";
import { stripePublicCheckoutEnabled } from "../payments/paymentService";
import { cancelPaymentSchema, initializePaymentSchema, verifyPaymentSchema } from "../validation/payment";
import { initializeStripeCheckoutSchema } from "../validation/payment";
import { getPublicPaymentStatus, initializeStripeCheckout } from "../services/stripePayments";
import { BadRequestError } from "../services/errors";
import { handleRouteError } from "./errorHandler";

/**
 * Sprint 64C: guest checkout payment routes only - the exact routes the storefront calls
 * directly with no admin session. Split out of payments.ts (which retains the administrative
 * listing route) so these can be mounted before the admin session boundary without making the
 * rest of the payments surface public. Reuses the same service/validation as the administrative
 * router - no duplicated business logic.
 */
export function createPaymentsPublicRouter(dependencies={initializeStripeCheckout,initializePaymentSession,verifyPaymentSession,cancelPaymentSession,getPublicPaymentStatus}){
const router = Router();

router.post("/initialize", async (req, res) => {
  try {
    if(req.body?.provider==="stripe"){
      // Sprint 134: explicit, fail-closed COD-only launch gate - checked before any Stripe-specific
      // logic runs, independent of whether Stripe keys/URLs happen to be configured in this environment.
      if(!stripePublicCheckoutEnabled()) throw new BadRequestError("Stripe checkout is not enabled in this environment");
      const input=initializeStripeCheckoutSchema.parse(req.body);const result=await dependencies.initializeStripeCheckout(db,{version:1,orderDraftId:input.orderDraftId,guestEmail:input.guestEmail,billingAddress:input.billingAddress,shippingAddress:input.shippingAddress,notes:input.notes,items:input.items});return res.status(201).json(result);}
    const input = initializePaymentSchema.parse(req.body);
    const result = await dependencies.initializePaymentSession(db, input);
    res.status(201).json(result);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/verify", async (req, res) => {
  try {
    const input = verifyPaymentSchema.parse(req.body);
    if(input.provider==="stripe")throw new BadRequestError("Stripe payments are verified by webhook only");
    const result = await dependencies.verifyPaymentSession(db, input);
    res.json(result);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/cancel", async (req, res) => {
  try {
    const input = cancelPaymentSchema.parse(req.body);
    if(input.provider==="stripe")throw new BadRequestError("Stripe payment cancellation is not browser-authoritative");
    const result = await dependencies.cancelPaymentSession(db, input);
    res.json(result);
  } catch (err) {
    handleRouteError(err, res);
  }
});
router.get("/:paymentId/status",async(req,res)=>{try{const result=await dependencies.getPublicPaymentStatus(db,req.params.paymentId);if(!result)return res.status(404).json({error:"Payment not found"});return res.json(result);}catch(err){handleRouteError(err,res);}});

return router;
}

export default createPaymentsPublicRouter();
