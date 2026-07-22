import { Router } from "express";
import { db } from "../db/client";
import { acceptOffer, createOffer, listOffers, rejectOffer } from "../services/offers";
import { createOfferSchema } from "../validation/offer";
import { handleRouteError } from "./errorHandler";

/**
 * Sprint 4 exposed offer creation. Sprint 36A adds admin management
 * (list/accept/reject); acceptance/rejection only change offer status.
 */
const router = Router();

router.get("/", async (_req, res) => {
  try {
    const items = await listOffers(db);
    res.json(items);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/", async (req, res) => {
  try {
    const input = createOfferSchema.parse(req.body);
    const offer = await createOffer(db, input);
    res.status(201).json(offer);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/:id/accept", async (req, res) => {
  try {
    const offer = await acceptOffer(db, req.params.id);
    res.json(offer);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/:id/reject", async (req, res) => {
  try {
    const offer = await rejectOffer(db, req.params.id);
    res.json(offer);
  } catch (err) {
    handleRouteError(err, res);
  }
});

export default router;
