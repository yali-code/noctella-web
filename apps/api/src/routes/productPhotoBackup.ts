import { Router } from "express";
import { requireSchedulerAuth } from "../auth/machineAuth";
import { logBackupFailure } from "../services/backupFailureDiagnostics";

export function createProductPhotoBackupRouter(run: () => Promise<unknown>) {
  const router = Router();
  router.post("/", requireSchedulerAuth, async (_req, res) => {
    try { res.json(await run()); }
    catch (error) {
      // ADS-009F: one allowlisted diagnostic line (stage/code/status only); response stays generic.
      logBackupFailure("product_photo_backup_failed", error);
      res.status(503).json({ error: "Product photo backup or verification failed" });
    }
  });
  return router;
}
