import { Router } from "express";
import { db } from "../db/client";
import {
  getPublicProductBySlug,
  listArchiveProducts,
  listPublicProducts,
  listRelatedProducts,
} from "../services/publicCatalog";
import { publicProductListQuerySchema } from "../validation/publicCatalog";
import { handleRouteError } from "./errorHandler";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const query = publicProductListQuerySchema.parse(req.query);
    const result = await listPublicProducts(db, query);
    res.json(result);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.get("/archive", async (req, res) => {
  try {
    const page = req.query.page ? Number(req.query.page) : 1;
    const pageSize = req.query.pageSize ? Number(req.query.pageSize) : 20;
    const result = await listArchiveProducts(db, { page, pageSize });
    res.json(result);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.get("/:slug", async (req, res) => {
  try {
    const product = await getPublicProductBySlug(db, req.params.slug);
    const related = await listRelatedProducts(db, product.id, product.categoryId);
    res.json({ ...product, relatedProducts: related });
  } catch (err) {
    handleRouteError(err, res);
  }
});

export default router;
