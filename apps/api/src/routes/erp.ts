import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { categories, collections, erpIntegrationAudit, erpIntegrationClients, erpSyncCheckpoints, productPhotos, stockMovements, products } from "../db/schema";
import { acknowledge, authenticateErp, capabilities, checkpoint, getProductProjection, health, identityCheck, isVersionSupported, listProductProjections, PRODUCT_FIELD_MAPPING, validateCommandEnvelope, versionInfo, audit } from "../services/erpIntegration";
import { buildErpMigrationManifestPreview, buildErpMigrationPreview, capabilities as migrationCapabilities, detectErpMigrationConflicts, ERP_MIGRATION_MAX_BYTES, validateErpMigrationSource } from "../services/erpMigration";

const router = Router();
const key = (req: any) => req.header("X-Noctella-ERP-Key");
const version = (req: any) => req.header("X-Noctella-ERP-Client-Version");
const requestId = (req: any) => req.header("X-Noctella-ERP-Request-Id");
async function requireErp(req: any, res: any, next: any) { const auth = await authenticateErp(db, key(req), version(req), requestId(req)); if (!auth.ok) return res.status(401).json({ error: auth.error }); if (!isVersionSupported(version(req))) return res.status(409).json({ error: "ERP client version is not supported", version: versionInfo(version(req)) }); req.erp=auth; next(); }

router.options("*", (req, res) => { const allow=(process.env.ERP_CORS_ORIGINS??"").split(",").map(s=>s.trim()).filter(Boolean); const origin=req.header("origin"); if(origin && allow.includes(origin)) res.header("Access-Control-Allow-Origin", origin); res.header("Access-Control-Allow-Headers", "Content-Type,X-Noctella-ERP-Key,X-Noctella-ERP-Client-Version,X-Noctella-ERP-Request-Id"); res.sendStatus(204); });
router.get("/version", (req, res) => res.json(versionInfo(version(req))));
router.get("/health", async (req, res) => { const publicOnly=!key(req); const h=await health(db); res.json(publicOnly ? { status: h.status, apiVersion: h.apiVersion, serverTime: h.serverTime } : h); });
router.get("/capabilities", requireErp, (_req, res) => res.json(capabilities()));

function parseMigrationPayload(req: any, res: any) { const len=Number(req.header("content-length") ?? 0); if (len > ERP_MIGRATION_MAX_BYTES) { res.status(413).json({ error:"ERP migration preview payload is too large" }); return null; } return req.body?.source ?? req.body ?? {}; }
async function auditMigration(req:any, action:string, result:any, success=true, errorCode?:string) { await audit(db, req.erp?.clientId ?? null, requestId(req), action, success?"Success":"Failure", { sourceType:result?.sourceType, sourceFingerprint:result?.fingerprint?.value, entityCounts:result?.entityCounts, conflictCount:result?.conflicts?.length ?? 0, blockingCount:result?.summary?.blockingCount ?? result?.issues?.filter?.((i:any)=>i.severity==="Blocking")?.length ?? 0, dryRun:true }, errorCode); }
router.get("/migration/capabilities", requireErp, (_req, res) => res.json(migrationCapabilities()));
router.get("/migration/mapping", requireErp, (_req, res) => res.json({ mappingVersion:"sprint17-preview-v1", productFields: PRODUCT_FIELD_MAPPING, classifications:["mapped","metadata","derived","deferred","unsupported"], dryRun:true }));
router.post("/migration/validate", requireErp, async (req:any, res) => { const payload=parseMigrationPayload(req,res); if (!payload) return; const result=validateErpMigrationSource(payload, req.body?.sourceType); await auditMigration(req,"ErpMigrationValidate",result,result.ok,result.ok?undefined:"VALIDATION_FAILED"); res.status(result.ok?200:400).json(result); });
router.post("/migration/preview", requireErp, async (req:any, res) => { const payload=parseMigrationPayload(req,res); if (!payload) return; const result=await buildErpMigrationPreview(db,payload,req.body?.sourceType); await auditMigration(req,"ErpMigrationPreview",result,result.ok,result.ok?undefined:"PREVIEW_BLOCKED"); res.status(result.ok?200:400).json(result); });
router.post("/migration/conflicts", requireErp, async (req:any, res) => { const payload=parseMigrationPayload(req,res); if (!payload) return; const conflicts=await detectErpMigrationConflicts(db,payload); res.json({ dryRun:true, conflicts }); });
router.post("/migration/manifest-preview", requireErp, async (req:any, res) => { const payload=parseMigrationPayload(req,res); if (!payload) return; const result=await buildErpMigrationManifestPreview(db,payload,req.body?.sourceType); await auditMigration(req,"ErpMigrationManifestPreview",result,result.ok,result.ok?undefined:"MANIFEST_BLOCKED"); res.status(result.ok?200:400).json(result.manifestPreview); });
router.get("/products", requireErp, async (req, res) => res.json(await listProductProjections(db, req.query)));
router.get("/products/by-erp-reference/:erpReferenceId", requireErp, async (req, res) => { const [p]=await db.select().from(products).where(eq(products.erpReferenceId, req.params.erpReferenceId)).limit(1); if(!p) return res.status(404).json({ error:"Product not found" }); res.json(await getProductProjection(db,p.id)); });
router.get("/products/:id", requireErp, async (req, res) => { const p=await getProductProjection(db, req.params.id); if(!p) return res.status(404).json({ error:"Product not found" }); res.json(p); });
router.get("/products/:id/availability", requireErp, async (req, res) => { const p=await getProductProjection(db, req.params.id); if(!p) return res.status(404).json({ error:"Product not found" }); res.json({ productId:p.centralProductId, physicalStock:p.physicalStock, reservedStock:0, reservedStockSupported:false, availableStock:p.availableStock }); });
router.get("/products/:id/movements", requireErp, async (req, res) => res.json({ items: await db.select().from(stockMovements).where(eq(stockMovements.productId, req.params.id)).orderBy(stockMovements.createdAt), readOnly:true }));
router.get("/products/:id/photos", requireErp, async (req, res) => res.json({ items: await db.select().from(productPhotos).where(eq(productPhotos.productId, req.params.id)).orderBy(productPhotos.sortOrder), readOnly:true }));
router.get("/categories", requireErp, async (_req, res) => res.json({ items: await db.select().from(categories).orderBy(categories.displayOrder, categories.name) }));
router.get("/collections", requireErp, async (_req, res) => res.json({ items: await db.select().from(collections).orderBy(collections.displayOrder, collections.name) }));
router.post("/products/identity-check", requireErp, async (req, res) => res.json(await identityCheck(db, req.body ?? {})));
router.get("/mapping/product-fields", requireErp, (_req, res) => res.json({ fields: PRODUCT_FIELD_MAPPING, excluded: [{ erpField:"imageDataUrl", currentSprintMode:"Deferred", notes:"Deferred to ProductPhoto migration; not silently dropped." }] }));
router.get("/sync/checkpoint", requireErp, async (_req, res) => res.json(await checkpoint(db)));
router.post("/sync/acknowledge", requireErp, async (req:any, res) => res.json(await acknowledge(db, req.erp.clientId, requestId(req), req.body?.checkpointToken, req.body?.safeMetadata)));
router.post("/commands/validate", requireErp, (req, res) => res.json(validateCommandEnvelope(req.body)));
router.get("/admin/overview", async (_req, res) => res.json({ version: versionInfo(), health: await health(db), capabilities: capabilities(), clients: await db.select({ id:erpIntegrationClients.id, name:erpIntegrationClients.name, keyVersion:erpIntegrationClients.keyVersion, isActive:erpIntegrationClients.isActive, lastSeenAt:erpIntegrationClients.lastSeenAt, lastClientVersion:erpIntegrationClients.lastClientVersion }).from(erpIntegrationClients), checkpoints: await db.select().from(erpSyncCheckpoints).orderBy(erpSyncCheckpoints.createdAt).limit(10), audit: await db.select().from(erpIntegrationAudit).orderBy(erpIntegrationAudit.createdAt).limit(20), mappingSummary: PRODUCT_FIELD_MAPPING }));
export default router;
