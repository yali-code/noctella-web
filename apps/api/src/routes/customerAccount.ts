import crypto from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { DbClient } from "../db/client";
import { customerAddresses, customerProfiles, orders } from "../db/schema";
import { addressSchema } from "../validation/order";
import { getOrderById } from "../services/orders";
import { customerToken, requireCustomerOrigin } from "./customerAuth";
import { resolveCustomerSession, type CustomerSessionIdentity } from "../services/customerIdentity";
import { handleRouteError } from "./errorHandler";

export function createCustomerAccountRouter(db: DbClient) {
const router = Router();
const savedAddressSchema = addressSchema.extend({ type: z.enum(["Shipping", "Billing"]), countryCode: z.string().trim().regex(/^[A-Za-z]{2}$/).transform((value) => value.toUpperCase()) });
type AuthenticatedRequest = Request & { customerIdentity?: CustomerSessionIdentity };
router.use(requireCustomerOrigin);
router.use(async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const identity = await resolveCustomerSession(db, customerToken(req));
    if (!identity) { res.status(401).json({ error: "Authentication required" }); return; }
    req.customerIdentity = identity;
    next();
  } catch (error) { handleRouteError(error, res); }
});

router.get("/profile", async (req: AuthenticatedRequest, res) => {
  try {
    const identity = req.customerIdentity!;
    const [profile] = await db.select({ name: customerProfiles.name, phone: customerProfiles.phone }).from(customerProfiles).where(eq(customerProfiles.id, identity.customerId)).limit(1);
    res.json({ email: identity.email, name: profile?.name ?? null, phone: profile?.phone ?? null });
  } catch (error) { handleRouteError(error, res); }
});
router.patch("/profile", async (req: AuthenticatedRequest, res) => {
  try {
    const input = z.object({ name: z.string().trim().min(1).max(200), phone: z.string().trim().max(50).nullable().optional() }).strict().parse(req.body);
    await db.update(customerProfiles).set({ name: input.name, phone: input.phone ?? null, updatedAt: new Date().toISOString() }).where(eq(customerProfiles.id, req.customerIdentity!.customerId));
    res.json({ ok: true });
  } catch (error) { handleRouteError(error, res); }
});

const addressProjection = (row: typeof customerAddresses.$inferSelect) => ({ id: row.id, type: row.type, fullName: row.name, line1: row.line1, line2: row.line2, city: row.city, region: row.region, postalCode: row.postalCode, country: row.country, countryCode: row.countryCode });
router.get("/addresses", async (req: AuthenticatedRequest, res) => {
  try {
    const rows = await db.select().from(customerAddresses).where(eq(customerAddresses.customerId, req.customerIdentity!.customerId)).orderBy(desc(customerAddresses.updatedAt));
    res.json({ items: rows.map(addressProjection) });
  } catch (error) { handleRouteError(error, res); }
});
router.post("/addresses", async (req: AuthenticatedRequest, res) => {
  try {
    const input = savedAddressSchema.strict().parse(req.body);
    const timestamp = new Date().toISOString();
    const row = { id: crypto.randomUUID(), customerId: req.customerIdentity!.customerId, type: input.type, name: input.fullName, line1: input.line1, line2: input.line2 ?? null, city: input.city, region: input.region ?? null, postalCode: input.postalCode, country: input.country, countryCode: input.countryCode, createdAt: timestamp, updatedAt: timestamp };
    await db.insert(customerAddresses).values(row);
    res.status(201).json(addressProjection({ ...row, fingerprint: null }));
  } catch (error) { handleRouteError(error, res); }
});
router.put("/addresses/:id", async (req: AuthenticatedRequest, res) => {
  try {
    const input = savedAddressSchema.strict().parse(req.body);
    const [updated] = await db.update(customerAddresses).set({ type: input.type, name: input.fullName, line1: input.line1, line2: input.line2 ?? null, city: input.city, region: input.region ?? null, postalCode: input.postalCode, country: input.country, countryCode: input.countryCode, updatedAt: new Date().toISOString() }).where(and(eq(customerAddresses.id, req.params.id), eq(customerAddresses.customerId, req.customerIdentity!.customerId))).returning();
    if (!updated) return res.status(404).json({ error: "Address not found" });
    res.json(addressProjection(updated));
  } catch (error) { handleRouteError(error, res); }
});
router.delete("/addresses/:id", async (req: AuthenticatedRequest, res) => {
  try {
    const removed = await db.delete(customerAddresses).where(and(eq(customerAddresses.id, req.params.id), eq(customerAddresses.customerId, req.customerIdentity!.customerId))).returning({ id: customerAddresses.id });
    if (!removed.length) return res.status(404).json({ error: "Address not found" });
    res.json({ ok: true });
  } catch (error) { handleRouteError(error, res); }
});

router.get("/orders", async (req: AuthenticatedRequest, res) => {
  try {
    const rows = await db.select({ id: orders.id, orderNumber: orders.orderNumber, status: orders.status, totalAmount: orders.totalAmount, currency: orders.currency, createdAt: orders.createdAt }).from(orders).where(eq(orders.customerId, req.customerIdentity!.customerId)).orderBy(desc(orders.createdAt)).limit(100);
    res.json({ items: rows });
  } catch (error) { handleRouteError(error, res); }
});
router.get("/orders/:id", async (req: AuthenticatedRequest, res) => {
  try {
    const [owned] = await db.select({ id: orders.id }).from(orders).where(and(eq(orders.id, req.params.id), eq(orders.customerId, req.customerIdentity!.customerId))).limit(1);
    if (!owned) return res.status(404).json({ error: "Order not found" });
    const order = await getOrderById(db, owned.id);
    res.json({
      id: order.id, orderNumber: order.orderNumber, status: order.status,
      paymentStatus: order.paymentStatus, totalAmount: order.totalAmount, currency: order.currency,
      createdAt: order.createdAt, shippingAddress: order.shippingAddress,
      billingAddress: order.billingAddress, shippingAmount: order.shippingAmount,
      shippingMethodLabel: order.shippingMethodLabel,
      items: (order.items as Array<Record<string, unknown>>).map((item) => ({
        productTitle: item.productTitle, quantity: item.quantity, unitPrice: item.unitPrice,
        totalPrice: item.totalPrice, productImageUrl: item.productImageUrl,
      })),
    });
  } catch (error) { handleRouteError(error, res); }
});

return router;
}
