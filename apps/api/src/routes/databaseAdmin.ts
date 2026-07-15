import { Router } from "express";
import { checkBackupReadiness, checkSqliteIntegrity, createMigrationPreview, getDatabaseHealth, runSchemaParity } from "../services/databaseMigrationFoundation";
const router = Router();
export function requireDatabaseAdmin(req: any, res: any, next: any) { const token=req.header("x-admin-token"); const role=req.header("x-admin-role"); if (process.env.ADMIN_API_TOKEN && token !== process.env.ADMIN_API_TOKEN) return res.status(401).json({error:"Admin authentication required"}); if (role !== "admin") return res.status(403).json({error:"Admin role required"}); next(); }
router.use(requireDatabaseAdmin);
router.get("/admin/database/health", async (_req,res,next)=>{ try { res.json(await getDatabaseHealth()); } catch(e){ next(e); } });
router.get("/admin/database/supabase-health", async (_req,res,next)=>{ try { const h:any=await getDatabaseHealth(); res.json({activeDriver:h.activeDriver,targetConfigured:h.supabaseConfigured,connectivityStatus:h.connectivity?.supabase,latencyMs:h.connectivity?.latencyMs,schemaVersion:h.schemaVersion}); } catch(e){ next(e); } });
router.get("/admin/database/migration-readiness", async (_req,res,next)=>{ try { const h:any=await getDatabaseHealth(); res.json({migrationReadiness:h.migrationReadiness,parityStatus:h.parityStatus,blockingIssueCount:h.blockingIssueCount,warningCount:h.warningCount,backup:checkBackupReadiness()}); } catch(e){ next(e); } });
router.get("/admin/database/parity", (_req,res)=>res.json(runSchemaParity()));
router.get("/admin/database/migration-preview", (_req,res)=>res.json(createMigrationPreview()));
router.get("/admin/database/integrity", (_req,res)=>res.json(checkSqliteIntegrity()));
export default router;
