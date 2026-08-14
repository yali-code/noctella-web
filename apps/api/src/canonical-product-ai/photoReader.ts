import { readFile } from "node:fs/promises";
import path from "node:path";
import { productPhotoStaticPath, productPhotoStaticRoot } from "../services/photoStorage";
import { BadRequestError, NotFoundError } from "../services/errors";
import type { CanonicalProductPhotoReader, CanonicalProductPhotoReference } from "./types";

/**
 * Sprint 148: resolves a canonical ProductPhoto's own public `url` (e.g. "/images/product-photos/
 * abc.webp") to its on-disk filename under the existing productPhotoStaticRoot, then reads the
 * real file bytes from that private-to-the-process filesystem root (never fetched over HTTP, and
 * never a new storage mechanism - reuses services/photoStorage.ts's existing exports unchanged).
 * Mirrors ai-intake/photoReader.ts's exact defense-in-depth shape (basename-only, reject any
 * path-traversal/segment-shaped input, confine the resolved read to the storage root) even though
 * `url` is itself server-generated (never client input) - the same safety posture as that file's
 * own "storage keys are internally generated... preserved as defense-in-depth" precedent.
 */
export class LocalCanonicalProductPhotoReader implements CanonicalProductPhotoReader {
  #root: string;

  constructor(root: string = productPhotoStaticRoot) {
    this.#root = root;
  }

  async read(photo: CanonicalProductPhotoReference): Promise<Buffer> {
    if (!photo.url || typeof photo.url !== "string" || !photo.url.startsWith(`${productPhotoStaticPath}/`)) {
      throw new BadRequestError("Invalid canonical product photo reference");
    }
    const filename = path.basename(photo.url);
    if (!filename || !/^[a-zA-Z0-9._-]+$/.test(filename)) {
      throw new BadRequestError("Invalid canonical product photo reference");
    }

    const rootResolved = path.resolve(this.#root);
    const resolved = path.resolve(this.#root, filename);
    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
      throw new BadRequestError("Invalid canonical product photo reference");
    }

    try {
      return await readFile(resolved);
    } catch (err: any) {
      if (err?.code === "ENOENT") throw new NotFoundError("Canonical product photo file not found");
      throw err;
    }
  }
}
