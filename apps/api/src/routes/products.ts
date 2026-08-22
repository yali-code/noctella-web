import { Router } from "express";
import multer from "multer";
import { requirePermission, type AuthedRequest } from "../auth/permissions";
import { db } from "../db/client";
import { archiveProduct, createProduct, deleteProductPhoto, getProductArchiveSafety, getProductById, listPendingPublishQueue, listProducts, reorderProductPhotos, setPrimaryProductPhoto, updateProduct, updateProductPhoto, uploadProductPhoto } from "../services/products";
import { createProductSchema, productListQuerySchema, updateProductRequestSchema } from "../validation/product";
import { generateDraft } from "../services/aiDrafts";
import { generateDraftSchema } from "../validation/aiDraft";
import { handleRouteError } from "./errorHandler";
import { getPublishPreview, getPublishValidation } from "../services/publishing";
import { executePublish, executePublishBatch, listExternalListings, endExternalListing } from "../services/marketplacePublishing";
import { publishRequestSchema, executePublishBatchRequestSchema } from "../validation/publishing";
import { approveMarketplacePreparation, generateMarketplacePreparation, getCurrentMarketplacePreparation } from "../services/marketplacePreparation";
import { approveMarketplacePreparationSchema, generateMarketplacePreparationSchema, getMarketplacePreparationQuerySchema } from "../validation/marketplacePreparation";
import { addProductMarketingTag, listProductMarketingTags, removeProductMarketingTag } from "../services/marketingTags";
import { addProductMarketingTagSchema } from "../validation/marketingTags";
import { acceptCanonicalProductProposal, generateCanonicalProductProposal, getCurrentCanonicalProductProposal } from "../services/canonicalProductProposal";
import { acceptCanonicalProductProposalSchema, generateCanonicalProductProposalSchema } from "../validation/canonicalProductProposal";
import { z } from "zod";
import { getProductLifecycleState, pauseProduct, relistProduct, retryLifecycleOperation } from "../services/productLifecycle";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const pauseLifecycleSchema = z.object({ idempotencyKey: z.string().min(8).max(200), reason: z.string().trim().max(500).optional() }).strict();

router.get("/:id/lifecycle", requirePermission("products.publish"), async (req,res)=>{try{res.json(await getProductLifecycleState(db,req.params.id));}catch(error){handleRouteError(error,res);}});
router.post("/:id/lifecycle/pause", requirePermission("products.publish"), async (req:AuthedRequest,res)=>{try{const input=pauseLifecycleSchema.parse(req.body??{});res.json(await pauseProduct(db,{productId:req.params.id,actorAdminUserId:req.adminUser!.id,...input}));}catch(error){handleRouteError(error,res);}});
router.post("/:id/lifecycle/relist", requirePermission("products.publish"), async (req:AuthedRequest,res)=>{try{const input=pauseLifecycleSchema.parse(req.body??{});res.json(await relistProduct(db,{productId:req.params.id,actorAdminUserId:req.adminUser!.id,...input}));}catch(error){handleRouteError(error,res);}});
router.post("/:id/lifecycle/:operationId/retry", requirePermission("products.publish"), async (req,res)=>{try{res.json(await retryLifecycleOperation(db,req.params.id,req.params.operationId));}catch(error){handleRouteError(error,res);}});
router.get("/:id/archive-safety", requirePermission("products.edit"), async (req,res)=>{try{res.json(await getProductArchiveSafety(db,req.params.id));}catch(error){handleRouteError(error,res);}});

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

// Sprint 141: unified/batch publish - thin orchestration only, delegates every selected channel to
// the existing, unmodified executePublish above (never a second publishing implementation). Same
// permission as the rest of this file's publish surface. No batch-level idempotency key is
// accepted - executePublishBatchRequestSchema's .strict() rejects one outright.
router.post("/:id/publish/execute-batch", requirePermission("products.publish"), async (req, res) => {
  try {
    const input = executePublishBatchRequestSchema.parse(req.body);
    // Sprint 146: expectedUpdatedAt is forwarded unchanged - executePublishBatch itself performs
    // the upfront whole-batch Product version comparison before attempting any channel.
    res.json(await executePublishBatch(db, req.params.id, input.channels, input.expectedUpdatedAt));
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

// Sprint 140: Product-scoped Marketing Tags - a distinct concept from Product Category, SEO
// keywords, Collections, and Etsy listing tags (see Sprint 139/140 Discovery). Explicit
// GET/POST/DELETE only - no replace-all endpoint, matching the approved Admin-wins ownership
// model (explicit add/remove is safer than a bulk replace that could silently drop tags an Admin
// did not intend to touch). GET reuses the existing view permission; POST/DELETE reuse the
// existing Product-edit permission, matching every other Product-mutating route in this file.
router.get("/:id/marketing-tags", requirePermission("products.view"), async (req, res) => {
  try {
    res.json(await listProductMarketingTags(db, req.params.id));
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/:id/marketing-tags", requirePermission("products.edit"), async (req, res) => {
  try {
    const input = addProductMarketingTagSchema.parse(req.body ?? {});
    res.status(201).json(await addProductMarketingTag(db, req.params.id, input.label));
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.delete("/:id/marketing-tags/:tagId", requirePermission("products.edit"), async (req, res) => {
  try {
    await removeProductMarketingTag(db, req.params.id, req.params.tagId);
    res.status(204).end();
  } catch (err) {
    handleRouteError(err, res);
  }
});

// Sprint 148: Canonical Product & Physical AI Suggestions - a dedicated, isolated proposal flow
// (never overloads PublishChannel, never reuses marketplace_preparations - see Sprint 148
// Architecture Review Option B). Generate/regenerate never mutates Product or Marketing Tags;
// Accept is the only mutation action, gated by an explicit selected-field allowlist (never "apply
// every suggested field") and Product/proposal optimistic concurrency. Reuses the existing
// products.edit/products.view permissions - Product Details/Physical Information/Marketing Tags
// are edited via products.edit everywhere else in this file (the generic PUT below, and the
// Marketing Tags routes above), so this is not publish-journey-scoped like Marketplace
// Preparation is.
router.post("/:id/canonical-ai-proposal", requirePermission("products.edit"), async (req, res) => {
  try {
    generateCanonicalProductProposalSchema.parse(req.body ?? {});
    res.json(await generateCanonicalProductProposal(db, req.params.id));
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.get("/:id/canonical-ai-proposal", requirePermission("products.view"), async (req, res) => {
  try {
    res.json(await getCurrentCanonicalProductProposal(db, req.params.id));
  } catch (err) {
    handleRouteError(err, res);
  }
});

// Actor identity always comes from req.adminUser.id, never the request body - mirrors every other
// approval endpoint in this codebase (Stock Acceptance, AI Draft approve, Marketplace Preparation approve).
router.post("/:id/canonical-ai-proposal/accept", requirePermission("products.edit"), async (req: AuthedRequest, res) => {
  try {
    const input = acceptCanonicalProductProposalSchema.parse(req.body ?? {});
    res.json(
      await acceptCanonicalProductProposal(
        db,
        req.params.id,
        { expectedProposalUpdatedAt: input.expectedProposalUpdatedAt, selectedProductFields: input.selectedProductFields, selectedMarketingTags: input.selectedMarketingTags },
        req.adminUser!.id,
      ),
    );
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
