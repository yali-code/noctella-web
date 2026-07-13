import { Router } from "express";
import { db } from "../db/client";
import { createStockMovement, getStockMovementById, listStockMovements } from "../services/stockMovements";
import { createStockMovementSchema, stockMovementListQuerySchema } from "../validation/stockMovement";
import { handleRouteError } from "./errorHandler";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const query = stockMovementListQuerySchema.parse(req.query);
    const result = await listStockMovements(db, query);
    res.json(result);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.get("/:id", async (req, res) => {
  try {
    const movement = await getStockMovementById(db, req.params.id);
    res.json(movement);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/", async (req, res) => {
  try {
    const input = createStockMovementSchema.parse(req.body);
    const movement = await createStockMovement(db, input);
    res.status(201).json(movement);
  } catch (err) {
    handleRouteError(err, res);
  }
});

export default router;
