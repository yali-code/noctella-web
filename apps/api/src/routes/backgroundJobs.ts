import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { backgroundJobs } from "../db/schema";
import { cancelJob, listJobs, retryJob } from "../services/backgroundJobs";
const router = Router();
// Sprint 64B: POST /run moved to index.ts, gated by requireSchedulerAuth (a machine bearer
// token independent of admin sessions) and mounted before the global requireAuth admin gate -
// scheduler calls must never need an admin session cookie.
router.get("/", async (req, res, next) => { try { res.json({ items: await listJobs(db, req.query as any) }); } catch (e) { next(e); } });
router.get("/:id", async (req, res, next) => { try { const [job] = await db.select().from(backgroundJobs).where(eq(backgroundJobs.id, req.params.id)); res.json(job); } catch (e) { next(e); } });
router.post("/:id/retry", async (req, res, next) => { try { await retryJob(db, req.params.id); res.json({ ok: true }); } catch (e) { next(e); } });
router.post("/:id/cancel", async (req, res, next) => { try { await cancelJob(db, req.params.id); res.json({ ok: true }); } catch (e) { next(e); } });
export default router;
