import { Router } from "express";
import { requirePermission } from "../auth/permissions";
import { db } from "../db/client";
import { acceptOffer, createDraftOrderFromOffer, createOffer, listOffers, rejectOffer } from "../services/offers";
import { createOfferSchema } from "../validation/offer";
import { handleRouteError } from "./errorHandler";

/**
 * Sprint 4 exposed offer creation. Sprint 36A adds admin management
 * (list/accept/reject); acceptance/rejection only change offer status.
 */
const router = Router();

router.get("/", requirePermission("orders.view"), async (_req, res) => {
  try {
    const items = await listOffers(db);
    res.json(items);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/", requirePermission("orders.manage"), async (req, res) => {
  try {
    const input = createOfferSchema.parse(req.body);
    const offer = await createOffer(db, input);
    res.status(201).json(offer);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/:id/accept", requirePermission("orders.manage"), async (req, res) => {
  try {
    const offer = await acceptOffer(db, req.params.id);
    res.json(offer);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/:id/reject", requirePermission("orders.manage"), async (req, res) => {
  try {
    const offer = await rejectOffer(db, req.params.id);
    res.json(offer);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/:id/draft-order", requirePermission("orders.manage"), async (req, res) => {
  try {
    const order = await createDraftOrderFromOffer(db, req.params.id);
    res.status(201).json(order);
  } catch (err) {
    handleRouteError(err, res);
  }
});

export default router;
