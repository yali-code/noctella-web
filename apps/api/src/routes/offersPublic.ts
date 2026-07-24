import { Router } from "express";
import { db } from "../db/client";
import { createOffer } from "../services/offers";
import { createOfferSchema } from "../validation/offer";
import { handleRouteError } from "./errorHandler";

/**
 * Sprint 65: guest "Make an Offer" submission only - the exact route the storefront calls
 * directly with no admin session. Split out of offers.ts (which retains every administrative
 * offer route) so this one route can be mounted before the admin session boundary without
 * making the rest of the offers surface public. Reuses the same service/validation as the
 * administrative router - no duplicated business logic.
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
