import { Router } from "express";
import { requireSchedulerAuth } from "../auth/machineAuth";

export function createProductPhotoBackupRouter(run: () => Promise<unknown>) {
  const router = Router();
  router.post("/", requireSchedulerAuth, async (_req, res) => {
    try { res.json(await run()); }
    catch { res.status(503).json({ error: "Product photo backup or verification failed" }); }
  });
  return router;
}
