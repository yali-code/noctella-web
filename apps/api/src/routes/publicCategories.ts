import { Router } from "express";
import { db } from "../db/client";
import { getPublicCategoryBySlug, listPublicCategories } from "../services/publicCatalog";
import { handleRouteError } from "./errorHandler";

const router = Router();

router.get("/", async (_req, res) => {
  try {
    const categories = await listPublicCategories(db);
    res.json({ items: categories });
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.get("/:slug", async (req, res) => {
  try {
    const category = await getPublicCategoryBySlug(db, req.params.slug);
    res.json(category);
  } catch (err) {
    handleRouteError(err, res);
  }
});

export default router;
