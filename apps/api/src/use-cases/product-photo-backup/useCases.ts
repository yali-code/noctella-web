import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_PRODUCT_PHOTO_BACKUP_ARTIFACT_BYTES, MAX_PRODUCT_PHOTO_BACKUP_MANIFEST_BYTES, type ProductPhotoArtifactRole, type ProductPhotoBackupObjectMetadata, type ProductPhotoBackupReferenceSource, type ProductPhotoBackupRepository, type ProductPhotoLocalFileSource } from "../../repositories/product-photo-backup/types";

export class ProductPhotoBackupError extends Error {
  constructor(message = "Product photo backup or verification failed") { super(message); this.name = "ProductPhotoBackupError"; }
}

export interface ProductPhotoBackupManifestEntry {
  photoId: string;
  productId: string;
  artifactRole: ProductPhotoArtifactRole;
  logicalStorageKey: string;
  remoteObjectKey: string;
  actualSizeBytes: number;
  sha256: string;
  mimeType: string;
  backupTimestamp: string;
}

export interface ProductPhotoBackupManifest {
  version: 1;
  backupTimestamp: string;
  entries: ProductPhotoBackupManifestEntry[];
  counts: { backedUpLocalArtifacts: number; reusedImmutableObjects: number; newlyUploadedObjects: number; unmanagedPhotoReferences: number };
}

async function sha256File(filePath: string) {
  const hash = createHash("sha256");
  let byteSize = 0;
  for await (const chunk of createReadStream(filePath)) { hash.update(chunk); byteSize += chunk.length; }
  return { sha256: hash.digest("hex"), byteSize };
}

function assertRemote(actual: ProductPhotoBackupObjectMetadata | null, expected: Pick<ProductPhotoBackupObjectMetadata, "objectKey" | "byteSize" | "sha256">) {
  if (!actual || actual.objectKey !== expected.objectKey || actual.byteSize !== expected.byteSize || actual.sha256 !== expected.sha256) throw new ProductPhotoBackupError();
}

async function verifyDownload(repository: ProductPhotoBackupRepository, expected: Pick<ProductPhotoBackupObjectMetadata, "objectKey" | "byteSize" | "sha256">, destinationPath: string) {
  let downloaded: number;
  try { downloaded = await repository.download(expected.objectKey, destinationPath, expected.byteSize); } catch { throw new ProductPhotoBackupError(); }
  if (downloaded !== expected.byteSize || (await stat(destinationPath)).size !== expected.byteSize) throw new ProductPhotoBackupError();
  const inspected = await sha256File(destinationPath);
  if (inspected.byteSize !== expected.byteSize || inspected.sha256 !== expected.sha256) throw new ProductPhotoBackupError();
}

function deterministicManifest(manifest: ProductPhotoBackupManifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function validateManifest(value: unknown): ProductPhotoBackupManifest {
  const manifest = value as ProductPhotoBackupManifest;
  if (!manifest || manifest.version !== 1 || typeof manifest.backupTimestamp !== "string" || !Array.isArray(manifest.entries) || !manifest.counts) throw new ProductPhotoBackupError();
  for (const entry of manifest.entries) {
    if (!entry || typeof entry.photoId !== "string" || typeof entry.productId !== "string" || !["main", "thumbnail"].includes(entry.artifactRole) || typeof entry.logicalStorageKey !== "string" || typeof entry.remoteObjectKey !== "string" || !Number.isSafeInteger(entry.actualSizeBytes) || entry.actualSizeBytes < 0 || entry.actualSizeBytes > MAX_PRODUCT_PHOTO_BACKUP_ARTIFACT_BYTES || !/^[a-f0-9]{64}$/.test(entry.sha256) || typeof entry.mimeType !== "string" || typeof entry.backupTimestamp !== "string") throw new ProductPhotoBackupError();
  }
  return manifest;
}

function assertManifestKey(key: string, prefix: string) {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`^${escaped}/manifests/[0-9]{8}T[0-9]{9}Z-[a-f0-9]{64}\\.json$`).test(key) || key.includes("..") || key.includes("\\")) throw new ProductPhotoBackupError();
}

export function createProductPhotoBackupUseCase(dependencies: { references: ProductPhotoBackupReferenceSource; files: ProductPhotoLocalFileSource; repository: ProductPhotoBackupRepository; prefix: string; pageSize?: number; now?: () => Date }) {
  return {
    async execute() {
      const backupTimestamp = (dependencies.now ?? (() => new Date()))().toISOString();
      const directory = await mkdtemp(path.join(os.tmpdir(), "noctella-photo-backup-"));
      const entries: ProductPhotoBackupManifestEntry[] = [];
      let reusedImmutableObjects = 0;
      let newlyUploadedObjects = 0;
      let unmanagedPhotoReferences = 0;
      try {
        let cursor: string | undefined;
        do {
          const page = await dependencies.references.listPage(cursor, dependencies.pageSize ?? 100);
          for (const reference of page.items) {
            if (!reference.locallyOwned) { unmanagedPhotoReferences += 1; continue; }
            for (const [artifactRole, logicalStorageKey] of [["main", reference.mainStorageKey], ["thumbnail", reference.thumbnailStorageKey]] as const) {
              if (!logicalStorageKey) throw new ProductPhotoBackupError();
              const artifact = await dependencies.files.inspect(logicalStorageKey);
              const remoteObjectKey = `${dependencies.prefix}/objects/${artifact.sha256}.webp`;
              const expected = { objectKey: remoteObjectKey, byteSize: artifact.byteSize, sha256: artifact.sha256, contentType: "image/webp", createdAt: backupTimestamp };
              let remote: ProductPhotoBackupObjectMetadata | null;
              try { remote = await dependencies.repository.head(remoteObjectKey); } catch { throw new ProductPhotoBackupError(); }
              if (remote) { assertRemote(remote, expected); reusedImmutableObjects += 1; }
              else {
                try { await dependencies.repository.upload(artifact.localPath, expected); } catch { throw new ProductPhotoBackupError(); }
                let uploaded: ProductPhotoBackupObjectMetadata | null;
                try { uploaded = await dependencies.repository.head(remoteObjectKey); } catch { throw new ProductPhotoBackupError(); }
                assertRemote(uploaded, expected);
                await verifyDownload(dependencies.repository, expected, path.join(directory, `${artifact.sha256}-${newlyUploadedObjects}.webp`));
                newlyUploadedObjects += 1;
              }
              entries.push({ photoId: reference.photoId, productId: reference.productId, artifactRole, logicalStorageKey, remoteObjectKey, actualSizeBytes: artifact.byteSize, sha256: artifact.sha256, mimeType: "image/webp", backupTimestamp });
            }
          }
          cursor = page.nextCursor;
        } while (cursor);
        entries.sort((a, b) => `${a.photoId}\0${a.artifactRole}\0${a.logicalStorageKey}`.localeCompare(`${b.photoId}\0${b.artifactRole}\0${b.logicalStorageKey}`));
        const manifest: ProductPhotoBackupManifest = { version: 1, backupTimestamp, entries, counts: { backedUpLocalArtifacts: entries.length, reusedImmutableObjects, newlyUploadedObjects, unmanagedPhotoReferences } };
        const content = deterministicManifest(manifest);
        const manifestBytes = Buffer.from(content);
        if (manifestBytes.byteLength > MAX_PRODUCT_PHOTO_BACKUP_MANIFEST_BYTES) throw new ProductPhotoBackupError();
        const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
        const timestamp = backupTimestamp.replace(/[-:.]/g, "");
        const manifestKey = `${dependencies.prefix}/manifests/${timestamp}-${manifestSha256}.json`;
        const localManifest = path.join(directory, "manifest.json");
        await writeFile(localManifest, manifestBytes, { flag: "wx" });
        const metadata = { objectKey: manifestKey, byteSize: manifestBytes.byteLength, sha256: manifestSha256, contentType: "application/json", createdAt: backupTimestamp };
        const existing = await dependencies.repository.head(manifestKey);
        if (existing) assertRemote(existing, metadata); else await dependencies.repository.upload(localManifest, metadata);
        assertRemote(await dependencies.repository.head(manifestKey), metadata);
        const remoteManifest = path.join(directory, "remote-manifest.json");
        await verifyDownload(dependencies.repository, metadata, remoteManifest);
        validateManifest(JSON.parse(await readFile(remoteManifest, "utf8")));
        return { manifestKey, manifestSha256, backedUpLocalArtifacts: entries.length, reusedImmutableObjects, newlyUploadedObjects, unmanagedPhotoReferences, remoteVerified: true as const };
      } catch (error) { throw error instanceof ProductPhotoBackupError ? error : new ProductPhotoBackupError(); }
      finally { await rm(directory, { recursive: true, force: true }).catch(() => undefined); }
    },
  };
}

export function createProductPhotoRecoveryVerificationUseCase(repository: ProductPhotoBackupRepository, prefix: string) {
  return {
    async execute(manifestKey: string) {
      assertManifestKey(manifestKey, prefix);
      const directory = await mkdtemp(path.join(os.tmpdir(), "noctella-photo-recovery-verification-"));
      try {
        const metadata = await repository.head(manifestKey);
        if (!metadata || !/^[a-f0-9]{64}$/.test(metadata.sha256) || !Number.isSafeInteger(metadata.byteSize) || metadata.byteSize <= 0 || metadata.byteSize > MAX_PRODUCT_PHOTO_BACKUP_MANIFEST_BYTES) throw new ProductPhotoBackupError();
        const manifestPath = path.join(directory, "manifest.json");
        await verifyDownload(repository, metadata, manifestPath);
        const manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf8")));
        let verifiedArtifacts = 0;
        for (const [index, entry] of manifest.entries.entries()) {
          if (entry.remoteObjectKey !== `${prefix}/objects/${entry.sha256}.webp`) throw new ProductPhotoBackupError();
          const remoteArtifact = await repository.head(entry.remoteObjectKey);
          if (remoteArtifact && remoteArtifact.byteSize > MAX_PRODUCT_PHOTO_BACKUP_ARTIFACT_BYTES) throw new ProductPhotoBackupError();
          assertRemote(remoteArtifact, { objectKey: entry.remoteObjectKey, byteSize: entry.actualSizeBytes, sha256: entry.sha256 });
          await verifyDownload(repository, { objectKey: entry.remoteObjectKey, byteSize: entry.actualSizeBytes, sha256: entry.sha256 }, path.join(directory, `artifact-${index}.webp`));
          verifiedArtifacts += 1;
        }
        return { manifestKey, verifiedArtifacts, integrity: "ok" as const };
      } catch (error) { throw error instanceof ProductPhotoBackupError ? error : new ProductPhotoBackupError(); }
      finally { await rm(directory, { recursive: true, force: true }).catch(() => undefined); }
    },
  };
}
