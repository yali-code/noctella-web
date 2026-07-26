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
class PhotoNotYetAvailableError extends Error { permanent = false; code = "PHOTO_FILE_NOT_YET_AVAILABLE"; }
// A directory must never satisfy a photo-file check: fs.stat + isFile() (rather than fs.access,
// which only checks visibility and succeeds for directories too) so a candidate path that
// resolves to PRODUCT_PHOTO_DIR itself (e.g. via a bare "." segment) is treated exactly like a
// missing file, not an existing one.
async function fileExists(file: string) { try { const stat = await fs.stat(file); return stat.isFile(); } catch (e: any) { if (e?.code === "ENOENT") return false; throw e; } }
async function assertFileExists(file: string) { if (!(await fileExists(file))) throw new PhotoNotYetAvailableError("Promoted file is not yet present on disk"); }
// Sprint 71 legacy recovery: rows created before the products.ts key-derivation fix persisted a
// malformed thumbnailStorageKey (e.g. "x.webp-thumb") that never matches the real file
// LocalPhotoStorage wrote ("x-thumb.webp"). thumbnailUrl was always correct, so - only when the
// stored key does not resolve to a real file - it is used as a one-time local recovery source.
// Only a relative, same-origin URL path is accepted: any URI scheme (http/https/file/data/blob,
// or a Windows drive letter like "C:") or a protocol-relative "//" is rejected outright, and only
// the final filename segment is taken (discarding the rest of the path). "." and ".." (or a
// segment containing either) are rejected outright, since "." would otherwise resolve to the
// storage root directory itself via safeJoin(); the surviving filename is still run through the
// same safeJoin() traversal check as every other storage key.
function deriveLegacyThumbnailFilename(url: unknown): string | undefined {
  if (typeof url !== "string" || !url) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//")) return undefined;
  const segments = url.split("/");
  const filename = segments[segments.length - 1];
  if (!filename || filename === "." || filename.includes("..") || filename.includes("\\")) return undefined;
  return filename;
}

export class ProductPhotoPromotionHandler implements OutboxHandler {
  eventType = OutboxEventType.ProductPhotoPromoteRequested;
  constructor(private readonly uow: UnitOfWork, private readonly roots: ProductPhotoStorageRoots) {}
  async handle(event: OutboxEvent) {
    const photoId = String(event.payload.photoId ?? event.aggregateId ?? "");
    await this.uow.run(async ({ repositories }) => {
      const [photo] = await repositories.db.select().from(productPhotos).where(eq(productPhotos.id, photoId)).limit(1);
      if (!photo || photo.processingStatus === ProductPhotoProcessingStatus.Ready) return;
      const storageKey = photo.storageKey ?? photo.filename;
      const thumbKey = photo.thumbnailStorageKey ?? `${photo.filename}-thumb`;
      const productWrite = repositories.productWrite ?? createProductWriteRepositoryBundleForDb(repositories.db);
      // Sprint 71: LocalPhotoStorage writes uploads directly into the single public serving
      // directory - there is no distinct temp stage for it to promote from. When tempRoot and
      // permanentRoot resolve to the same directory, the file is already at its permanent,
      // public location, so promotion must never copy a file onto itself or unlink it (that
      // would delete the live photo) - it only has to confirm both files exist before flipping
      // processingStatus to Ready. A missing file is left Processing for the outbox retry policy.
      const samePhysicalRoot = path.resolve(this.roots.tempRoot) === path.resolve(this.roots.permanentRoot);
      if (samePhysicalRoot) {
        await assertFileExists(safeJoin(this.roots.permanentRoot, storageKey));
        if (!(await fileExists(safeJoin(this.roots.permanentRoot, thumbKey)))) {
          const recovered = deriveLegacyThumbnailFilename(photo.thumbnailUrl);
          if (!recovered || !(await fileExists(safeJoin(this.roots.permanentRoot, recovered)))) {
            throw new PhotoNotYetAvailableError("Promoted thumbnail file is not yet present on disk");
          }
          await productWrite.photos.updateStorageMetadata(photoId, { thumbnailStorageKey: recovered });
        }
        await productWrite.photos.updateProcessingState(photoId, { processingStatus: ProductPhotoProcessingStatus.Ready, processingErrorCode: null, processingUpdatedAt: new Date().toISOString() });
        return;
      }
      await copyIdempotent(safeJoin(this.roots.tempRoot, storageKey), safeJoin(this.roots.permanentRoot, storageKey));
      await copyIdempotent(safeJoin(this.roots.tempRoot, thumbKey), safeJoin(this.roots.permanentRoot, thumbKey));
      await productWrite.photos.updateStorageMetadata(photoId, { url: `${this.roots.publicBase ?? "/images/product-photos"}/${storageKey}`, thumbnailUrl: `${this.roots.publicBase ?? "/images/product-photos"}/${thumbKey}`, storageKey, thumbnailStorageKey: thumbKey });
      await productWrite.photos.updateProcessingState(photoId, { processingStatus: ProductPhotoProcessingStatus.Ready, processingErrorCode: null, processingUpdatedAt: new Date().toISOString() });
      await unlinkIdempotent(safeJoin(this.roots.tempRoot, storageKey));
      await unlinkIdempotent(safeJoin(this.roots.tempRoot, thumbKey));
    });
  }
}
export class ProductPhotoDeleteHandler implements OutboxHandler { eventType = OutboxEventType.ProductPhotoDeleteRequested; constructor(private readonly roots: ProductPhotoStorageRoots) {} async handle(event: OutboxEvent) { const p:any=event.payload; for (const key of [p.storageKey,p.thumbnailStorageKey]) if (typeof key === "string") await unlinkIdempotent(safeJoin(this.roots.permanentRoot,key)); if (typeof p.url === "string" && isExternal(p.url)) return; } }
export class ProductPhotoCleanupTempHandler implements OutboxHandler { eventType = OutboxEventType.ProductPhotoCleanupTempRequested; constructor(private readonly roots: ProductPhotoStorageRoots) {} async handle(event: OutboxEvent) { const p:any=event.payload; for (const key of [p.storageKey,p.thumbnailStorageKey]) if (typeof key === "string") await unlinkIdempotent(safeJoin(this.roots.tempRoot,key)); } }
export const productPhotoStorageSafety = { safeJoin, isExternal };
