import { Router } from "express";
import { requirePermission } from "../auth/permissions";
import { db } from "../db/client";
import {
  archiveCategory,
  createCategory,
  getCategoryById,
  listCategories,
  restoreCategory,
  updateCategory,
} from "../services/categories";
import { categoryListQuerySchema, createCategorySchema, updateCategorySchema } from "../validation/category";
import { handleRouteError } from "./errorHandler";

const router = Router();

router.get("/", requirePermission("products.view"), async (req, res) => {
  try {
    const query = categoryListQuerySchema.parse(req.query);
    const result = await listCategories(db, query);
    res.json(result);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.get("/:id", requirePermission("products.view"), async (req, res) => {
  try {
    const category = await getCategoryById(db, req.params.id);
    res.json(category);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/", requirePermission("products.edit"), async (req, res) => {
  try {
    const input = createCategorySchema.parse(req.body);
    const category = await createCategory(db, input);
    res.status(201).json(category);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.put("/:id", requirePermission("products.edit"), async (req, res) => {
  try {
    const input = updateCategorySchema.parse(req.body);
    const category = await updateCategory(db, req.params.id, input);
    res.json(category);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/:id/archive", requirePermission("products.edit"), async (req, res) => {
  try {
    const category = await archiveCategory(db, req.params.id);
    res.json(category);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/:id/restore", requirePermission("products.edit"), async (req, res) => {
  try {
    const category = await restoreCategory(db, req.params.id);
    res.json(category);
  } catch (err) {
    handleRouteError(err, res);
  }
});

export default router;
