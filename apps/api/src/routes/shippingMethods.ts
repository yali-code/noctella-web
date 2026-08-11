import { Router } from "express";
import { requirePermission } from "../auth/permissions";
import { db } from "../db/client";
import { createShippingMethod, getShippingMethodById, listShippingMethods, updateShippingMethod } from "../services/shippingMethods";
import { createShippingMethodSchema, updateShippingMethodSchema } from "../validation/shipping";
import { handleRouteError } from "./errorHandler";

/** Sprint 134: Admin-managed shipping-method configuration - no hard delete, active/inactive only (see services/shippingMethods.ts). Reuses the existing settings.manage permission, matching companyProfile's own settings-configuration classification. */
const router = Router();

router.get("/", requirePermission("settings.manage"), async (_req, res) => {
  try {
    res.json({ items: await listShippingMethods(db) });
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.get("/:id", requirePermission("settings.manage"), async (req, res) => {
  try {
    res.json(await getShippingMethodById(db, req.params.id));
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/", requirePermission("settings.manage"), async (req, res) => {
  try {
    const input = createShippingMethodSchema.parse(req.body);
    res.status(201).json(await createShippingMethod(db, input));
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.put("/:id", requirePermission("settings.manage"), async (req, res) => {
  try {
    const input = updateShippingMethodSchema.parse(req.body);
    res.json(await updateShippingMethod(db, req.params.id, input));
  } catch (err) {
    handleRouteError(err, res);
  }
});

export default router;
