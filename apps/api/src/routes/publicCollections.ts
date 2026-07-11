import { Router } from "express";
import { db } from "../db/client";
import { getPublicCollectionBySlug, listPublicCollections } from "../services/publicCatalog";
import { handleRouteError } from "./errorHandler";

const router = Router();

router.get("/", async (_req, res) => {
  try {
    const collections = await listPublicCollections(db);
    res.json({ items: collections });
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.get("/:slug", async (req, res) => {
  try {
    const collection = await getPublicCollectionBySlug(db, req.params.slug);
    res.json(collection);
  } catch (err) {
    handleRouteError(err, res);
  }
});

export default router;
