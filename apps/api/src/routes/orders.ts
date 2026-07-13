import { Router } from "express";
import { db } from "../db/client";
import { createOrder, getOrderById, listOrders, updateOrderStatus } from "../services/orders";
import { createOrderSchema, orderListQuerySchema, updateOrderStatusSchema } from "../validation/order";
import { handleRouteError } from "./errorHandler";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const query = orderListQuerySchema.parse(req.query);
    const result = await listOrders(db, query);
    res.json(result);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/", async (req, res) => {
  try {
    const input = createOrderSchema.parse(req.body);
    const order = await createOrder(db, input);
    res.status(201).json(order);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.patch("/:id/status", async (req, res) => {
  try {
    const input = updateOrderStatusSchema.parse(req.body);
    const order = await updateOrderStatus(db, req.params.id, input);
    res.json(order);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.get("/:id", async (req, res) => {
  try {
    const order = await getOrderById(db, req.params.id);
    res.json(order);
  } catch (err) {
    handleRouteError(err, res);
  }
});

export default router;
