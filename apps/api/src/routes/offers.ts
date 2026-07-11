import { Router } from "express";
import { db } from "../db/client";
import { createOffer } from "../services/offers";
import { createOfferSchema } from "../validation/offer";
import { handleRouteError } from "./errorHandler";

/**
 * Sprint 4: minimal "Make an Offer" persistence. Only creation is exposed
 * here — admin management of offers (list/accept/reject) is a later sprint.
 */
const router = Router();

router.post("/", async (req, res) => {
  try {
    const input = createOfferSchema.parse(req.body);
    const offer = await createOffer(db, input);
    res.status(201).json(offer);
  } catch (err) {
    handleRouteError(err, res);
  }
});

export default router;
