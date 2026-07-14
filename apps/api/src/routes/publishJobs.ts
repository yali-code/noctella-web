import { Router } from "express";
import { db } from "../db/client";
import { getPublishJob, listPublishJobs, retryPublishJob } from "../services/marketplacePublishing";
import { handleRouteError } from "./errorHandler";
const router = Router();
router.get("/", async (req, res) => { try { res.json(await listPublishJobs(db, { channel: req.query.channel as never, status: req.query.status as never, limit: req.query.limit ? Number(req.query.limit) : undefined, offset: req.query.offset ? Number(req.query.offset) : undefined })); } catch (err) { handleRouteError(err, res); } });
router.get("/:id", async (req, res) => { try { res.json(await getPublishJob(db, req.params.id)); } catch (err) { handleRouteError(err, res); } });
router.post("/:id/retry", async (req, res) => { try { res.json(await retryPublishJob(db, req.params.id)); } catch (err) { handleRouteError(err, res); } });
export default router;
