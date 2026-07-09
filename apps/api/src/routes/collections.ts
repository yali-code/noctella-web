import { Router } from "express";
import { db } from "../db/client";
import {
  archiveCollection,
  createCollection,
  getCollectionById,
  listCollections,
  restoreCollection,
  updateCollection,
} from "../services/collections";
import {
  collectionListQuerySchema,
  createCollectionSchema,
  updateCollectionSchema,
} from "../validation/collection";
import { handleRouteError } from "./errorHandler";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const query = collectionListQuerySchema.parse(req.query);
    const result = await listCollections(db, query);
    res.json(result);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.get("/:id", async (req, res) => {
  try {
    const collection = await getCollectionById(db, req.params.id);
    res.json(collection);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/", async (req, res) => {
  try {
    const input = createCollectionSchema.parse(req.body);
    const collection = await createCollection(db, input);
    res.status(201).json(collection);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.put("/:id", async (req, res) => {
  try {
    const input = updateCollectionSchema.parse(req.body);
    const collection = await updateCollection(db, req.params.id, input);
    res.json(collection);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/:id/archive", async (req, res) => {
  try {
    const collection = await archiveCollection(db, req.params.id);
    res.json(collection);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/:id/restore", async (req, res) => {
  try {
    const collection = await restoreCollection(db, req.params.id);
    res.json(collection);
  } catch (err) {
    handleRouteError(err, res);
  }
});

export default router;
