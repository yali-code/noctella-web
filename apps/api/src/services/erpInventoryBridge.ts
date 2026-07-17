import crypto from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { ProductStatus, ProductType, StockMovementType } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { erpCommandExecutions, productErpMetadata, productPhotos, products, stockMovements, categories, collections } from "../db/schema";
import { BadRequestError, ConflictError, NotFoundError } from "./errors";
import { audit } from "./erpIntegration";
import { createProduct, updateProduct, uploadProductPhoto, updateProductPhoto, setPrimaryProductPhoto, reorderProductPhotos, deleteProductPhoto } from "./products";
import { createProductWriteServiceContextForDb } from "../repositories/product-write/factory";
import { upsertProductErpMetadataUseCase } from "../use-cases/product-write/useCases";
import { applyStockMovement } from "./stockMovements";
import type { PhotoStorage } from "./photoStorage";

type Envelope = { commandId:string; requestId?:string; clientId?:string; clientVersion?:string; commandType:string; entityType?:string; entityId?:string; idempotencyKey:string; payload:any; createdAt?:string };
const checksum = (v: unknown) => crypto.createHash("sha256").update(JSON.stringify(v ?? {})).digest("hex");
const metadataFields = ["noctellaId","barcodeValue","purchaseSource","provenance","previousOwner","auctionHouse","invoiceReferenceNumber","storageLocationReference","shippingCostEur","packagingCostEur","miscCostsEur","actualSalePriceEur","productWorkflowStatus","photoStatus","authenticationStatus","marketplacePreparationStatus","internalPriority","operationalNotes","depthValue","depthUnit","diameterValue","diameterUnit"];
const forbiddenUpdate = ["stockQuantity","reservedQuantity","availableQuantity","orderState","financials","marketplaceCredentials","priceUsd","minOfferPrice","ebayTitle","etsyTitle","wooProductName"];

async function execution(db: DbClient, clientId: string, env: Envelope) {
  if (!env?.idempotencyKey) throw new BadRequestError("idempotencyKey is required");
  if (!env?.commandId || !env?.commandType || !env?.payload) throw new BadRequestError("Valid ERP command envelope is required");
  const sum = checksum({ commandType: env.commandType, entityId: env.entityId, payload: env.payload });
  const [existing] = await db.select().from(erpCommandExecutions).where(and(eq(erpCommandExecutions.clientId, clientId), eq(erpCommandExecutions.idempotencyKey, env.idempotencyKey))).limit(1);
  if (existing) {
    if (existing.requestChecksum !== sum) throw new ConflictError("Idempotency key was already used for a different payload");
    return { existing, sum };
  }
  const now = new Date().toISOString();
  await db.insert(erpCommandExecutions).values({ id: crypto.randomUUID(), clientId, commandId: env.commandId, requestId: env.requestId ?? null, idempotencyKey: env.idempotencyKey, commandType: env.commandType, entityType: env.entityType ?? "Product", entityId: env.entityId ?? null, status: "Accepted", requestChecksum: sum, createdAt: now });
  return { existing: null, sum };
}
async function complete(db: DbClient, clientId: string, env: Envelope, status: string, entityId: string | null, meta: unknown, error?: string) {
  const now = new Date().toISOString();
  await db.update(erpCommandExecutions).set({ status, entityId, resultReference: entityId, safeResultMetadata: JSON.stringify(meta ?? {}), safeErrorCode: error ?? null, completedAt: now }).where(and(eq(erpCommandExecutions.clientId, clientId), eq(erpCommandExecutions.idempotencyKey, env.idempotencyKey)));
  await audit(db, clientId, env.requestId, env.commandType, status, meta, error);
}
function prior(row: any) { return { status: row.status, entityId: row.entityId, resultReference: row.resultReference, metadata: row.safeResultMetadata ? JSON.parse(row.safeResultMetadata) : {} }; }
function metaFrom(payload: any) { return Object.fromEntries(metadataFields.filter(k => payload?.[k] !== undefined).map(k => [k, payload[k]])); }
async function upsertMeta(db: DbClient, productId: string, meta: any) { const write = createProductWriteServiceContextForDb(db); await upsertProductErpMetadataUseCase({ unitOfWork: { run: async <T>(work: (context: never) => T | Promise<T>) => work(undefined as never) }, repositories: write.repositories }, productId, meta); }

export async function executeCreateProduct(db: DbClient, clientId: string, env: Envelope) {
  const ex = await execution(db, clientId, env); if (ex.existing) return prior(ex.existing);
  const p = env.payload ?? {}; if (!p.sku || !p.title || !p.categoryId || p.priceEur == null) throw new BadRequestError("sku, title, categoryId and priceEur are required");
  if (p.erpReferenceId && await createProductWriteServiceContextForDb(db).repositories.products.existsByErpReference(String(p.erpReferenceId))) throw new ConflictError("erpReferenceId is already in use");
  if (p.noctellaId && await createProductWriteServiceContextForDb(db).repositories.products.existsByNoctellaId(String(p.noctellaId))) throw new ConflictError("noctellaId is already in use");
  const result = await (async () => { const product = await createProduct(db, { sku:String(p.sku), title:String(p.title), slug:p.slug, type:p.type ?? ProductType.UniqueItem, status:p.status ?? ProductStatus.Draft, categoryId:String(p.categoryId), collectionId:p.collectionId, brand:p.brand, countryOfOrigin:p.countryOfOrigin, period:p.period, materials:p.materials, condition:p.condition, lengthValue:p.lengthValue, widthValue:p.widthValue, heightValue:p.heightValue, dimensionUnit:p.dimensionUnit, weightValue:p.weightValue, weightUnit:p.weightUnit, stockQuantity:0, purchaseCost:p.purchaseCost, purchaseCurrency:"EUR", internalNotes:p.internalNotes, priceEur:Number(p.priceEur), erpReferenceId:p.erpReferenceId } as any); await upsertMeta(db, product.id, metaFrom(p)); return { productId: product.id, sku: product.sku, erpReferenceId:p.erpReferenceId }; })();
  await complete(db, clientId, env, "Succeeded", result.productId, result); return { status:"Succeeded", ...result };
}
export async function executeUpdateProduct(db: DbClient, clientId: string, productId: string, env: Envelope) {
  const ex = await execution(db, clientId, { ...env, entityId: productId }); if (ex.existing) return prior(ex.existing);
  const p = env.payload ?? {}; const [existing]=await db.select().from(products).where(eq(products.id, productId)).limit(1); if(!existing) throw new NotFoundError("Product not found"); if(p.expectedUpdatedAt && p.expectedUpdatedAt !== existing.updatedAt) throw new ConflictError("Product has changed since expectedUpdatedAt"); const bad=Object.keys(p).filter(k=>forbiddenUpdate.includes(k)); if(bad.length) throw new BadRequestError(`ERP cannot update fields: ${bad.join(", ")}`);
  const productPatch:any={}; for (const [from,to] of Object.entries({ title:"title", categoryId:"categoryId", collectionId:"collectionId", brand:"brand", countryOfOrigin:"countryOfOrigin", period:"period", materials:"materials", condition:"condition", lengthValue:"lengthValue", widthValue:"widthValue", heightValue:"heightValue", dimensionUnit:"dimensionUnit", weightValue:"weightValue", weightUnit:"weightUnit", purchaseCost:"purchaseCost", priceEur:"priceEur", internalNotes:"internalNotes" })) if(p[from]!==undefined) productPatch[to]=p[from];
  const result = await (async ()=>{ if(Object.keys(productPatch).length) await updateProduct(db, productId, productPatch); await upsertMeta(db, productId, metaFrom(p)); return { productId, updatedFields:[...Object.keys(productPatch), ...Object.keys(metaFrom(p))] }; })();
  await complete(db, clientId, env, "Succeeded", productId, result); return { status:"Succeeded", ...result };
}
export async function executeStockAdjustment(db: DbClient, clientId: string, productId: string, env: Envelope) {
  const ex = await execution(db, clientId, { ...env, entityId: productId }); if (ex.existing) return prior(ex.existing);
  const p=env.payload??{}; const delta=Number(p.quantityDelta); if(!Number.isInteger(delta) || delta===0) throw new BadRequestError("Non-zero integer quantityDelta is required"); if(!p.reason && !p.note) throw new BadRequestError("reason or note is required"); let movement:any;
  movement = await applyStockMovement(db, { productId, type: StockMovementType.ManualAdjustment, quantityDelta: delta, note: String(p.reason ?? p.note), idempotencyKey: `erp:${clientId}:${env.idempotencyKey}` });
  const meta={ productId, previousQuantity: movement.stockBefore, delta, newQuantity: movement.stockAfter, movementId: movement.id }; await complete(db, clientId, env, "Succeeded", productId, meta); return { status:"Succeeded", ...meta };
}
export function calculateLandedCost(purchaseCost?: number|null, shipping?: number|null, packaging?: number|null, misc?: number|null, expected?: number|null) { const complete=[purchaseCost,shipping,packaging,misc].every(v=>typeof v==="number"); const landedCost=complete ? Number(purchaseCost!+shipping!+packaging!+misc!) : null; const expectedGrossProfit=landedCost!=null && typeof expected==="number" ? expected-landedCost : null; return { currency:"EUR", landedCost, complete, missing:[ ["purchaseCost",purchaseCost], ["shippingCostEur",shipping], ["packagingCostEur",packaging], ["miscCostsEur",misc] ].filter(([,v])=>typeof v!=="number").map(([k])=>k), expectedGrossProfit, expectedRoi: expectedGrossProfit!=null && landedCost ? expectedGrossProfit/landedCost : null }; }
export async function workspace(db: DbClient, id: string) { const [r]=await db.select({ p:products, m:productErpMetadata, c:categories, col:collections }).from(products).leftJoin(productErpMetadata, eq(productErpMetadata.productId, products.id)).leftJoin(categories, eq(categories.id, products.categoryId)).leftJoin(collections, eq(collections.id, products.collectionId)).where(eq(products.id,id)).limit(1); if(!r) throw new NotFoundError("Product not found"); const photos=await db.select().from(productPhotos).where(eq(productPhotos.productId,id)).orderBy(desc(productPhotos.isPrimary), productPhotos.sortOrder); const landed=calculateLandedCost(r.p.purchaseCost, r.m?.shippingCostEur, r.m?.packagingCostEur, r.m?.miscCostsEur, r.p.priceEur); return { centralProductId:id, erpReferenceId:r.p.erpReferenceId, noctellaId:r.m?.noctellaId, sku:r.p.sku, title:r.p.title, category:r.c?.name, collection:r.col?.name, brand:r.p.brand, condition:r.p.condition, provenance:r.m?.provenance, dimensions:{ length:r.p.lengthValue, width:r.p.widthValue, height:r.p.heightValue, unit:r.p.dimensionUnit, depth:r.m?.depthValue, depthUnit:r.m?.depthUnit, diameter:r.m?.diameterValue, diameterUnit:r.m?.diameterUnit }, weight:{ value:r.p.weightValue, unit:r.p.weightUnit }, purchaseCost:r.p.purchaseCost, shippingCostEur:r.m?.shippingCostEur, packagingCostEur:r.m?.packagingCostEur, miscCostsEur:r.m?.miscCostsEur, landedCost:landed, expectedSalePrice:r.p.priceEur, actualSalePriceEur:r.m?.actualSalePriceEur, physicalStock:r.p.stockQuantity, reservedStock:0, availableStock:r.p.stockQuantity, workflowStatus:r.m?.productWorkflowStatus, photoStatus:r.m?.photoStatus, authenticationStatus:r.m?.authenticationStatus, marketplacePreparationStatus:r.m?.marketplacePreparationStatus, primaryPhoto:photos[0]?.url ?? null, photoCount:photos.length, barcodeValue:r.m?.barcodeValue, storageLocationReference:r.m?.storageLocationReference, publishReadinessSummary:{ ready: photos.length>0 && r.p.priceEur>0, missing:[...(photos.length?[]:["photo"]), ...(r.p.priceEur>0?[]:["price"])] }, updatedAt:r.p.updatedAt }; }
export async function labelData(db: DbClient, id: string) { const w:any=await workspace(db,id); return { productId:id, noctellaId:w.noctellaId, sku:w.sku, barcodeValue:w.barcodeValue ?? null, title:w.title, category:w.category, priceEur:w.expectedSalePrice, locationReference:w.storageLocationReference, primaryPhotoThumbnail:w.primaryPhoto, printDimensions:{ unit:"mm", width:60, height:40 }, generatedAt:new Date().toISOString() }; }
export const barcode = labelData;
export { uploadProductPhoto, updateProductPhoto, setPrimaryProductPhoto, reorderProductPhotos, deleteProductPhoto };
