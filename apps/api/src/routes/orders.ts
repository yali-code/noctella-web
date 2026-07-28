import { Router } from "express";
import { requirePermission } from "../auth/permissions";
import { db } from "../db/client";
import { getOrderById, listOrders, updateOrderStatus } from "../services/orders";
import { getOrderInvoiceOutboxStatus, retrySalesInvoiceDraftForOrder } from "../services/salesInvoiceOutbox";
import { orderListQuerySchema, updateOrderStatusSchema } from "../validation/order";
import { handleRouteError } from "./errorHandler";

/** Sprint 64C: guest order creation (POST /) moved to routes/ordersPublic.ts, mounted before
 * the admin session boundary - this router now covers administrative order routes only. */
const router = Router();

router.get("/", requirePermission("orders.view"), async (req, res) => {
  try {
    const query = orderListQuerySchema.parse(req.query);
    const result = await listOrders(db, query);
    res.json(result);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.patch("/:id/status", requirePermission("orders.manage"), async (req, res) => {
  try {
    const input = updateOrderStatusSchema.parse(req.body);
    const order = await updateOrderStatus(db, req.params.id, input);
    res.json(order);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.get("/:id", requirePermission("orders.view"), async (req, res) => {
  try {
    const order = await getOrderById(db, req.params.id);
    res.json(order);
  } catch (err) {
    handleRouteError(err, res);
  }
});

/** Sprint 79 requirement #4: minimal Admin visibility into the durable automatic-SalesInvoice-draft outbox event for this order. */
router.get("/:id/invoice-status", requirePermission("orders.view"), async (req, res) => {
  try {
    res.json(await getOrderInvoiceOutboxStatus(db, req.params.id));
  } catch (err) {
    handleRouteError(err, res);
  }
});

/** Sprint 79 requirement #4: authorized retry — re-enqueues/reactivates the durable outbox event, never calls createAutomaticSalesInvoiceDraft directly. */
router.post("/:id/invoice-status/retry", requirePermission("orders.manage"), async (req, res) => {
  try {
    res.json(await retrySalesInvoiceDraftForOrder(db, req.params.id));
  } catch (err) {
    handleRouteError(err, res);
  }
});

export default router;
