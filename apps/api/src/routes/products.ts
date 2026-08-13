import { Router } from "express";
import multer from "multer";
import { requirePermission, type AuthedRequest } from "../auth/permissions";
import { db } from "../db/client";
import { archiveProduct, createProduct, deleteProductPhoto, getProductById, listPendingPublishQueue, listProducts, reorderProductPhotos, setPrimaryProductPhoto, updateProduct, updateProductPhoto, uploadProductPhoto } from "../services/products";
import { createProductSchema, productListQuerySchema, updateProductRequestSchema } from "../validation/product";
import { generateDraft } from "../services/aiDrafts";
import { generateDraftSchema } from "../validation/aiDraft";
import { handleRouteError } from "./errorHandler";
import { getPublishPreview, getPublishValidation } from "../services/publishing";
import { executePublish, listExternalListings, endExternalListing } from "../services/marketplacePublishing";
import { publishRequestSchema } from "../validation/publishing";
import { approveMarketplacePreparation, generateMarketplacePreparation, getCurrentMarketplacePreparation } from "../services/marketplacePreparation";
import { approveMarketplacePreparationSchema, generateMarketplacePreparationSchema, getMarketplacePreparationQuerySchema } from "../validation/marketplacePreparation";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.get("/", requirePermission("products.view"), async (req, res) => {
  try {
    const query = productListQuerySchema.parse(req.query);
    const result = await listProducts(db, query);
    res.json(result);
  } catch (err) {
    handleRouteError(err, res);
  }
});

/**
 * Sprint 139: Pending Publish queue - a dedicated read path rather than an overload of the
 * generic status filter above, since eligibility here is a join against ai_product_intakes
 * provenance, not a plain Product column predicate. Registered before "/:id" below so
 * "pending-publish" is never captured as an :id param.
 */
router.get("/pending-publish", requirePermission("products.view"), async (req, res) => {
  try {
    const query = productListQuerySchema.parse(req.query);
    const result = await listPendingPublishQueue(db, query);
    res.json(result);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.get("/:id/publish", requirePermission("products.publish"), async (req, res) => {
  try {
    const input = publishRequestSchema.parse(req.query);
    res.json(await getPublishPreview(db, req.params.id, input.channel));
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/:id/publish/validate", requirePermission("products.publish"), async (req, res) => {
  try {
    const input = publishRequestSchema.parse(req.body);
    res.json(await getPublishValidation(db, req.params.id, input.channel));
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/:id/publish/preview", requirePermission("products.publish"), async (req, res) => {
  try {
    const input = publishRequestSchema.parse(req.body);
    res.json(await getPublishPreview(db, req.params.id, input.channel));
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/:id/publish/execute", requirePermission("products.publish"), async (req, res) => {
  try {
    const input = publishRequestSchema.parse(req.body);
    res.json(await executePublish(db, req.params.id, input.channel, req.body?.idempotencyKey));
  } catch (err) { handleRouteError(err, res); }
});

router.get("/:id/external-listings", requirePermission("products.publish"), async (req, res) => {
  try { res.json(await listExternalListings(db, req.params.id)); } catch (err) { handleRouteError(err, res); }
});

router.post("/:id/external-listings/:listingId/end", requirePermission("products.publish"), async (req, res) => {
  try { res.json(await endExternalListing(db, req.params.id, req.params.listingId)); } catch (err) { handleRouteError(err, res); }
});

// Sprint 107: Marketplace Preparation - a new stage strictly BEFORE the existing, unchanged
// publish pipeline above (validatePublish/buildPublishPayload/executePublish). Never publishes,
// never creates a PublishJob/PublishAttempt/ExternalListing, never calls eBay/Etsy, never changes
// Product.status or any marketplace listing status - approval only copies admin-reviewed values
// onto the existing Product marketplace-field columns those existing publish routes already read.
// Same permission as the rest of this file's publish surface (products.publish governs the whole
// publish-adjacent journey, matching this file's own established convention above).
router.post("/:id/marketplace-preparation", requirePermission("products.publish"), async (req, res) => {
  try {
    const input = generateMarketplacePreparationSchema.parse(req.body ?? {});
    res.json(await generateMarketplacePreparation(db, req.params.id, input.channel));
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.get("/:id/marketplace-preparation", requirePermission("products.publish"), async (req, res) => {
  try {
    const input = getMarketplacePreparationQuerySchema.parse(req.query);
    res.json(await getCurrentMarketplacePreparation(db, req.params.id, input.channel));
  } catch (err) {
    handleRouteError(err, res);
  }
});

// Actor identity always comes from req.adminUser.id, never the request body - mirrors every other
// approval endpoint in this codebase (Stock Acceptance, AI Draft approve).
router.post("/:id/marketplace-preparation/approve", requirePermission("products.publish"), async (req: AuthedRequest, res) => {
  try {
    const input = approveMarketplacePreparationSchema.parse(req.body ?? {});
    res.json(await approveMarketplacePreparation(db, req.params.id, input, req.adminUser!.id));
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.get("/:id", requirePermission("products.view"), async (req, res) => {
  try {
    const product = await getProductById(db, req.params.id);
    res.json(product);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/", requirePermission("products.edit"), async (req, res) => {
  try {
    const input = createProductSchema.parse(req.body);
    const product = await createProduct(db, input);
    res.status(201).json(product);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.put("/:id", requirePermission("products.edit"), async (req, res) => {
  try {
    const input = updateProductRequestSchema.parse(req.body);
    const product = await updateProduct(db, req.params.id, input);
    res.json(product);
  } catch (err) {
    handleRouteError(err, res);
  }
});


router.post("/:id/photos", requirePermission("products.edit"), upload.single("photo"), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "Photo file is required" });
      return;
    }
    const photo = await uploadProductPhoto(db, req.params.id, req.file, typeof req.body.altText === "string" ? req.body.altText : undefined);
    res.status(201).json(photo);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.put("/:id/photos/:photoId", requirePermission("products.edit"), async (req, res) => {
  try {
    const photo = await updateProductPhoto(db, req.params.id, req.params.photoId, typeof req.body.altText === "string" ? req.body.altText : undefined);
    res.json(photo);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/:id/photos/:photoId/primary", requirePermission("products.edit"), async (req, res) => {
  try {
    res.json(await setPrimaryProductPhoto(db, req.params.id, req.params.photoId));
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/:id/photos/reorder", requirePermission("products.edit"), async (req, res) => {
  try {
    res.json(await reorderProductPhotos(db, req.params.id, req.body.photoIds));
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.delete("/:id/photos/:photoId", requirePermission("products.edit"), async (req, res) => {
  try {
    res.json(await deleteProductPhoto(db, req.params.id, req.params.photoId));
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/:id/archive", requirePermission("products.edit"), async (req, res) => {
  try {
    const product = await archiveProduct(db, req.params.id);
    res.json(product);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/:productId/ai-drafts/generate", requirePermission("products.edit"), async (req, res) => {
  try {
    generateDraftSchema.parse(req.body ?? {});
    const draft = await generateDraft(db, req.params.productId);
    res.status(201).json(draft);
  } catch (err) {
    handleRouteError(err, res);
  }
});

export default router;
