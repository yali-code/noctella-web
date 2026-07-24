import { Router } from "express";
import { checkBackupReadiness, checkSqliteIntegrity, createMigrationPreview, getDatabaseHealth, runSchemaParity } from "../services/databaseMigrationFoundation";
const router = Router();
/**
 * Sprint 64B: the previous requireDatabaseAdmin header check (x-admin-token/x-admin-role) is
 * removed - it was optional (skipped entirely when ADMIN_API_TOKEN was unset) and trivially
 * spoofable (x-admin-role was a client-supplied header). This router is now covered by the
 * global requireAuth mount in index.ts like every other admin route; no per-router gate remains.
 */
router.get("/admin/database/health", async (_req,res,next)=>{ try { res.json(await getDatabaseHealth()); } catch(e){ next(e); } });
router.get("/admin/database/supabase-health", async (_req,res,next)=>{ try { const h:any=await getDatabaseHealth(); res.json({activeDriver:h.activeDriver,targetConfigured:h.supabaseConfigured,connectivityStatus:h.connectivity?.supabase,latencyMs:h.connectivity?.latencyMs,schemaVersion:h.schemaVersion}); } catch(e){ next(e); } });
router.get("/admin/database/migration-readiness", async (_req,res,next)=>{ try { const h:any=await getDatabaseHealth(); res.json({migrationReadiness:h.migrationReadiness,parityStatus:h.parityStatus,blockingIssueCount:h.blockingIssueCount,warningCount:h.warningCount,backup:checkBackupReadiness()}); } catch(e){ next(e); } });
router.get("/admin/database/parity", (_req,res)=>res.json(runSchemaParity()));
router.get("/admin/database/migration-preview", (_req,res)=>res.json(createMigrationPreview()));
router.get("/admin/database/integrity", (_req,res)=>res.json(checkSqliteIntegrity()));
export default router;
