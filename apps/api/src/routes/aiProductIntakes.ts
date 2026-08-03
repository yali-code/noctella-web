import { Router } from "express";
import { requirePermission, type AuthedRequest } from "../auth/permissions";
import { db } from "../db/client";
import { cancelIntake, createIntake, getIntakeById, listIntakes } from "../services/aiProductIntakes";
import {
  aiProductIntakeListQuerySchema,
  cancelAiProductIntakeSchema,
  createAiProductIntakeSchema,
} from "../validation/aiProductIntake";
import { handleRouteError } from "./errorHandler";

const router = Router();

router.post("/", requirePermission("ai_product_intakes.manage"), async (req: AuthedRequest, res) => {
  try {
    createAiProductIntakeSchema.parse(req.body ?? {});
    // Creator identity comes only from the authenticated session -
    // requirePermission already guarantees req.adminUser is set, never from
    // a client-supplied body field.
    const intake = await createIntake(db, req.adminUser!.id);
    res.status(201).json(intake);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.get("/", requirePermission("ai_product_intakes.view"), async (req, res) => {
  try {
    const query = aiProductIntakeListQuerySchema.parse(req.query);
    const result = await listIntakes(db, query);
    res.json(result);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.get("/:id", requirePermission("ai_product_intakes.view"), async (req, res) => {
  try {
    const intake = await getIntakeById(db, req.params.id);
    res.json(intake);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/:id/cancel", requirePermission("ai_product_intakes.manage"), async (req: AuthedRequest, res) => {
  try {
    const input = cancelAiProductIntakeSchema.parse(req.body ?? {});
    // Canceller identity comes only from the authenticated session, never a
    // client-supplied body field.
    const intake = await cancelIntake(db, req.params.id, req.adminUser!.id, input.cancellationReason);
    res.json(intake);
  } catch (err) {
    handleRouteError(err, res);
  }
});

export default router;
