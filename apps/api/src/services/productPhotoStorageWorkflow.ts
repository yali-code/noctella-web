import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { ProductPhoto } from "@noctella/shared";
import { productPhotos } from "../db/schema";
import type { UnitOfWork } from "./unitOfWork";
import { OutboxEventType, type OutboxEvent, type OutboxHandler } from "./outbox";
import { ProductPhotoProcessingStatus } from "./productPhotoOutboxWorkflow";
import { createProductWriteRepositoryBundleForDb } from "../repositories/product-write/factory";

export interface ProductPhotoStorageRoots { tempRoot: string; permanentRoot: string; publicBase?: string }
export class UnsafeStoragePathError extends Error { permanent = true; code = "UNSAFE_STORAGE_PATH"; }
export class PermanentPhotoStorageError extends Error { permanent = true; code = "PHOTO_STORAGE_PERMANENT"; }
function safeJoin(root: string, key: string) { if (!key || key.includes("..") || path.isAbsolute(key)) throw new UnsafeStoragePathError("Unsafe storage key"); const full = path.resolve(root, key); const resolved = path.resolve(root); if (full !== resolved && !full.startsWith(resolved + path.sep)) throw new UnsafeStoragePathError("Unsafe storage root"); return full; }
async function copyIdempotent(src:string,dest:string){ try { await fs.mkdir(path.dirname(dest),{recursive:true}); await fs.copyFile(src,dest); } catch(e:any) { if (e?.code === "ENOENT") return; throw e; } }
async function unlinkIdempotent(file:string){ try { await fs.unlink(file); } catch(e:any) { if (e?.code !== "ENOENT") throw e; } }
function isExternal(url:string){ return /^https?:\/\//i.test(url); }

export class ProductPhotoPromotionHandler implements OutboxHandler {
  eventType = OutboxEventType.ProductPhotoPromoteRequested;
  constructor(private readonly uow: UnitOfWork, private readonly roots: ProductPhotoStorageRoots) {}
  async handle(event: OutboxEvent) { const photoId = String(event.payload.photoId ?? event.aggregateId ?? ""); await this.uow.run(async ({repositories}) => { const [photo] = await repositories.db.select().from(productPhotos).where(eq(productPhotos.id, photoId)).limit(1); if (!photo || photo.processingStatus === ProductPhotoProcessingStatus.Ready) return; const storageKey = photo.storageKey ?? photo.filename; const thumbKey = photo.thumbnailStorageKey ?? `${photo.filename}-thumb`; await copyIdempotent(safeJoin(this.roots.tempRoot, storageKey), safeJoin(this.roots.permanentRoot, storageKey)); await copyIdempotent(safeJoin(this.roots.tempRoot, thumbKey), safeJoin(this.roots.permanentRoot, thumbKey)); const productWrite = repositories.productWrite ?? createProductWriteRepositoryBundleForDb(repositories.db); await productWrite.photos.updateStorageMetadata(photoId, { url: `${this.roots.publicBase ?? "/images/product-photos"}/${storageKey}`, thumbnailUrl: `${this.roots.publicBase ?? "/images/product-photos"}/${thumbKey}`, storageKey, thumbnailStorageKey: thumbKey }); await productWrite.photos.updateProcessingState(photoId, { processingStatus: ProductPhotoProcessingStatus.Ready, processingErrorCode: null, processingUpdatedAt: new Date().toISOString() }); await unlinkIdempotent(safeJoin(this.roots.tempRoot, storageKey)); await unlinkIdempotent(safeJoin(this.roots.tempRoot, thumbKey)); }); }
}
export class ProductPhotoDeleteHandler implements OutboxHandler { eventType = OutboxEventType.ProductPhotoDeleteRequested; constructor(private readonly roots: ProductPhotoStorageRoots) {} async handle(event: OutboxEvent) { const p:any=event.payload; for (const key of [p.storageKey,p.thumbnailStorageKey]) if (typeof key === "string") await unlinkIdempotent(safeJoin(this.roots.permanentRoot,key)); if (typeof p.url === "string" && isExternal(p.url)) return; } }
export class ProductPhotoCleanupTempHandler implements OutboxHandler { eventType = OutboxEventType.ProductPhotoCleanupTempRequested; constructor(private readonly roots: ProductPhotoStorageRoots) {} async handle(event: OutboxEvent) { const p:any=event.payload; for (const key of [p.storageKey,p.thumbnailStorageKey]) if (typeof key === "string") await unlinkIdempotent(safeJoin(this.roots.tempRoot,key)); } }
export const productPhotoStorageSafety = { safeJoin, isExternal };
