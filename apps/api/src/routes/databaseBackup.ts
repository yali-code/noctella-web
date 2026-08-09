import { Router } from "express";
import { requireSchedulerAuth } from "../auth/machineAuth";
import type { DatabaseBackupObjectMetadata } from "../repositories/database-backup/types";

export function createDatabaseBackupRouter(run: () => Promise<DatabaseBackupObjectMetadata & { integrity: "ok"; remoteVerified: true }>) {
  const router = Router();
  router.post("/", requireSchedulerAuth, async (_req, res) => {
    try { res.json(await run()); }
    catch { res.status(503).json({ error: "Database backup or verification failed" }); }
  });
  return router;
}
