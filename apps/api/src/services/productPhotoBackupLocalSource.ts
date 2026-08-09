import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { MAX_PRODUCT_PHOTO_BACKUP_ARTIFACT_BYTES, type ProductPhotoLocalFileSource } from "../repositories/product-photo-backup/types";

export class ProductPhotoBackupLocalFileError extends Error {
  constructor() { super("Product photo backup local artifact validation failed"); this.name = "ProductPhotoBackupLocalFileError"; }
}

function safePath(root: string, storageKey: string) {
  if (!storageKey || path.isAbsolute(storageKey) || storageKey.includes("..") || storageKey.includes("/") || storageKey.includes("\\")) throw new ProductPhotoBackupLocalFileError();
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, storageKey);
  if (!candidate.startsWith(`${resolvedRoot}${path.sep}`)) throw new ProductPhotoBackupLocalFileError();
  return candidate;
}

export function createProductPhotoLocalFileSource(root: string, runtime: { lstat?: typeof lstat } = {}): ProductPhotoLocalFileSource {
  const statFile = runtime.lstat ?? lstat;
  return {
    async inspect(storageKey) {
      const localPath = safePath(root, storageKey);
      let before;
      try { before = await statFile(localPath); } catch { throw new ProductPhotoBackupLocalFileError(); }
      if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_PRODUCT_PHOTO_BACKUP_ARTIFACT_BYTES) throw new ProductPhotoBackupLocalFileError();
      const hash = createHash("sha256");
      let byteSize = 0;
      let handle;
      try {
        handle = await open(localPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const opened = await handle.stat();
        if (!opened.isFile() || opened.ino !== before.ino) throw new ProductPhotoBackupLocalFileError();
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
          byteSize += chunk.length;
          if (byteSize > MAX_PRODUCT_PHOTO_BACKUP_ARTIFACT_BYTES) throw new ProductPhotoBackupLocalFileError();
          hash.update(chunk);
        }
        const openedAfter = await handle.stat();
        if (opened.size !== openedAfter.size || opened.mtimeMs !== openedAfter.mtimeMs || opened.ino !== openedAfter.ino) throw new ProductPhotoBackupLocalFileError();
      } catch { throw new ProductPhotoBackupLocalFileError(); }
      finally { await handle?.close().catch(() => undefined); }
      let after;
      try { after = await statFile(localPath); } catch { throw new ProductPhotoBackupLocalFileError(); }
      if (!after.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || byteSize !== after.size) throw new ProductPhotoBackupLocalFileError();
      return { localPath, byteSize, sha256: hash.digest("hex") };
    },
  };
}
