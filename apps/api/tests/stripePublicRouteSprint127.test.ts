import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createPaymentsPublicRouter } from "../src/routes/paymentsPublic";

vi.hoisted(() => {
  process.env.DATABASE_DRIVER = "sqlite";
  process.env.DATABASE_URL = ":memory:";
  // Sprint 134: this suite deliberately exercises the real public Stripe-initialization route
  // itself, so it explicitly opts into the new COD-only launch gate rather than relying on any
  // default - see payments/paymentService.ts's stripePublicCheckoutEnabled.
  process.env.STRIPE_PUBLIC_CHECKOUT_ENABLED = "true";
});

const address={fullName:"Jane Buyer",line1:"1 Main",city:"Paris",postalCode:"75001",country:"FR"};
function fixture(){const initializeStripeCheckout=vi.fn(async()=>({paymentId:"payment-1",checkoutUrl:"https://checkout.stripe.test/1"}));const initializePaymentSession=vi.fn();const verifyPaymentSession=vi.fn();const cancelPaymentSession=vi.fn();const getPublicPaymentStatus=vi.fn();const app=express().use(express.json()).use("/api/payments",createPaymentsPublicRouter({initializeStripeCheckout,initializePaymentSession,verifyPaymentSession,cancelPaymentSession,getPublicPaymentStatus} as any));return{app,initializeStripeCheckout,verifyPaymentSession,cancelPaymentSession};}
const valid={provider:"stripe",orderDraftId:"draft-1",guestEmail:"buyer@example.com",billingAddress:address,shippingAddress:address,items:[{productId:"product-1",quantity:1}]};

describe("Sprint 127 public Stripe authority",()=>{
  it.each(["amount","currency","successUrl","cancelUrl","metadata"])("rejects browser-controlled %s",async field=>{const f=fixture();const response=await request(f.app).post("/api/payments/initialize").send({...valid,[field]:field==="amount"?1:"attacker"});expect(response.status).toBe(400);expect(f.initializeStripeCheckout).not.toHaveBeenCalled();});
  it("passes only validated durable intent to real Stripe initialization",async()=>{const f=fixture();const response=await request(f.app).post("/api/payments/initialize").send(valid);expect(response.status).toBe(201);expect(f.initializeStripeCheckout.mock.calls[0][1]).toEqual({version:1,orderDraftId:"draft-1",guestEmail:"buyer@example.com",billingAddress:address,shippingAddress:address,items:[{productId:"product-1",quantity:1}]});});
  it("rejects Stripe verify even when mock payments are enabled",async()=>{vi.stubEnv("MOCK_PAYMENTS_ENABLED","true");const f=fixture();const response=await request(f.app).post("/api/payments/verify").send({provider:"stripe",providerReference:"cs_test"});expect(response.status).toBe(400);expect(f.verifyPaymentSession).not.toHaveBeenCalled();vi.unstubAllEnvs();});
  it("rejects browser Stripe cancellation without mutation",async()=>{const f=fixture();const response=await request(f.app).post("/api/payments/cancel").send({provider:"stripe",providerReference:"cs_test"});expect(response.status).toBe(400);expect(f.cancelPaymentSession).not.toHaveBeenCalled();});
});
