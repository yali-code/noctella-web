import { Router } from "express";
import { requireSchedulerAuth } from "../auth/machineAuth";
import type { DatabaseBackupObjectMetadata } from "../repositories/database-backup/types";
import { logBackupFailure } from "../services/backupFailureDiagnostics";

export function createDatabaseBackupRouter(run: () => Promise<DatabaseBackupObjectMetadata & { integrity: "ok"; remoteVerified: true }>) {
  const router = Router();
  router.post("/", requireSchedulerAuth, async (_req, res) => {
    try { res.json(await run()); }
    catch (error) {
      // ADS-009F: one allowlisted diagnostic line (stage/code/status only); response stays generic.
      logBackupFailure("database_backup_failed", error);
      res.status(503).json({ error: "Database backup or verification failed" });
    }
  });
  return router;
}
