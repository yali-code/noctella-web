import { Router } from "express";
import { db } from "../db/client";
import { createManualStockAdjustment, listStockMovements } from "../services/stockMovements";
import { manualStockAdjustmentSchema, stockMovementListQuerySchema } from "../validation/stockMovement";
import { handleRouteError } from "./errorHandler";

const router = Router();

router.get("/", async (req, res) => {
  try {
    res.json(await listStockMovements(db, stockMovementListQuerySchema.parse(req.query)));
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/adjustments", async (req, res) => {
  try {
    res.status(201).json(await createManualStockAdjustment(db, manualStockAdjustmentSchema.parse(req.body)));
  } catch (err) {
    handleRouteError(err, res);
  }
});

export default router;
