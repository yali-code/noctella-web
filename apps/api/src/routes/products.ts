import { Router } from "express";
import multer from "multer";
import { db } from "../db/client";
import { archiveProduct, createProduct, deleteProductPhoto, getProductById, listProducts, reorderProductPhotos, setPrimaryProductPhoto, updateProduct, updateProductPhoto, uploadProductPhoto } from "../services/products";
import { createProductSchema, productListQuerySchema, updateProductSchema } from "../validation/product";
import { generateDraft } from "../services/aiDrafts";
import { generateDraftSchema } from "../validation/aiDraft";
import { handleRouteError } from "./errorHandler";
import { buildPublishPreview, getPublishReadinessSummary, validateProductForPublish } from "../services/publishing";
import { publishChannelSchema } from "../validation/publishing";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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



router.get("/:id/publish", async (req, res) => {
  try {
    res.json(await getPublishReadinessSummary(db, req.params.id));
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/:id/publish/validate", async (req, res) => {
  try {
    const { channel } = publishChannelSchema.parse(req.body);
    res.json(await validateProductForPublish(db, req.params.id, channel));
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/:id/publish/preview", async (req, res) => {
  try {
    const { channel } = publishChannelSchema.parse(req.body);
    res.json(await buildPublishPreview(db, req.params.id, channel));
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/:id/photos", upload.single("photo"), async (req, res) => {
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

router.put("/:id/photos/:photoId", async (req, res) => {
  try {
    const photo = await updateProductPhoto(db, req.params.id, req.params.photoId, typeof req.body.altText === "string" ? req.body.altText : undefined);
    res.json(photo);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/:id/photos/:photoId/primary", async (req, res) => {
  try {
    res.json(await setPrimaryProductPhoto(db, req.params.id, req.params.photoId));
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/:id/photos/reorder", async (req, res) => {
  try {
    res.json(await reorderProductPhotos(db, req.params.id, req.body.photoIds));
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.delete("/:id/photos/:photoId", async (req, res) => {
  try {
    res.json(await deleteProductPhoto(db, req.params.id, req.params.photoId));
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
