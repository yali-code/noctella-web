import { Router } from "express";
import { db } from "../db/client";
import { archiveProduct, createProduct, getProductById, listProducts, updateProduct } from "../services/products";
import { createProductSchema, productListQuerySchema, updateProductSchema } from "../validation/product";
import { generateDraft } from "../services/aiDrafts";
import { generateDraftSchema } from "../validation/aiDraft";
import { handleRouteError } from "./errorHandler";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const query = productListQuerySchema.parse(req.query);
    const result = await listProducts(db, query);
    res.json(result);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.get("/:id", async (req, res) => {
  try {
    const product = await getProductById(db, req.params.id);
    res.json(product);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/", async (req, res) => {
  try {
    const input = createProductSchema.parse(req.body);
    const product = await createProduct(db, input);
    res.status(201).json(product);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.put("/:id", async (req, res) => {
  try {
    const input = updateProductSchema.parse(req.body);
    const product = await updateProduct(db, req.params.id, input);
    res.json(product);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/:id/archive", async (req, res) => {
  try {
    const product = await archiveProduct(db, req.params.id);
    res.json(product);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/:productId/ai-drafts/generate", async (req, res) => {
  try {
    generateDraftSchema.parse(req.body ?? {});
    const draft = await generateDraft(db, req.params.productId);
    res.status(201).json(draft);
  } catch (err) {
    handleRouteError(err, res);
  }
});

export default router;
