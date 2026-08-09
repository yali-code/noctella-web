import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createReadStream } from "node:fs";
import { open, rm } from "node:fs/promises";
import type { ProductPhotoBackupObjectMetadata, ProductPhotoBackupRepository } from "./types";

export interface S3CompatibleProductPhotoBackupConfig {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  prefix: string;
}

export class ProductPhotoBackupConfigurationError extends Error {
  constructor() { super("Product photo backup storage is not configured"); this.name = "ProductPhotoBackupConfigurationError"; }
}

export function readS3CompatibleProductPhotoBackupConfig(env: NodeJS.ProcessEnv = process.env): S3CompatibleProductPhotoBackupConfig {
  const region = env.PRODUCT_PHOTO_BACKUP_S3_REGION?.trim();
  const bucket = env.PRODUCT_PHOTO_BACKUP_S3_BUCKET?.trim();
  const accessKeyId = env.PRODUCT_PHOTO_BACKUP_S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.PRODUCT_PHOTO_BACKUP_S3_SECRET_ACCESS_KEY?.trim();
  if (!region || !bucket || !accessKeyId || !secretAccessKey) throw new ProductPhotoBackupConfigurationError();
  const prefix = (env.PRODUCT_PHOTO_BACKUP_S3_PREFIX?.trim() || "product-photo-backups").replace(/^\/+|\/+$/g, "");
  if (!prefix || prefix.includes("..") || prefix.split("/").some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))) {
    throw new ProductPhotoBackupConfigurationError();
  }
  return { endpoint: env.PRODUCT_PHOTO_BACKUP_S3_ENDPOINT?.trim() || undefined, region, bucket, accessKeyId, secretAccessKey, forcePathStyle: env.PRODUCT_PHOTO_BACKUP_S3_FORCE_PATH_STYLE === "true", prefix };
}

export function createS3CompatibleProductPhotoBackupRepository(config: S3CompatibleProductPhotoBackupConfig, client = new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: config.forcePathStyle, credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } })): ProductPhotoBackupRepository {
  return {
    async head(objectKey) {
      try {
        const result = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: objectKey }));
        const byteSize = Number(result.ContentLength);
        const metadataSize = Number(result.Metadata?.["size-bytes"]);
        if (!Number.isSafeInteger(byteSize) || byteSize < 0 || metadataSize !== byteSize) throw new Error("Product photo backup remote size metadata is invalid");
        return { objectKey, byteSize, sha256: result.Metadata?.sha256 ?? "", contentType: result.ContentType ?? "application/octet-stream", createdAt: result.Metadata?.["created-at"] ?? "" };
      } catch (error: any) {
        if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NotFound" || error?.name === "NoSuchKey") return null;
        throw error;
      }
    },
    async upload(localPath, metadata) {
      await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: metadata.objectKey, Body: createReadStream(localPath), ContentLength: metadata.byteSize, ContentType: metadata.contentType, Metadata: { sha256: metadata.sha256, "size-bytes": String(metadata.byteSize), "created-at": metadata.createdAt } }));
    },
    async download(objectKey, destinationPath, maximumBytes) {
      const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: objectKey }));
      if (!result.Body || !(Symbol.asyncIterator in result.Body)) throw new Error("Product photo backup download failed");
      const file = await open(destinationPath, "wx");
      let byteSize = 0;
      let failed = false;
      try {
        for await (const value of result.Body as AsyncIterable<Uint8Array>) {
          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
          byteSize += chunk.byteLength;
          if (byteSize > maximumBytes) throw new Error("Product photo backup download exceeded expected size");
          await file.write(chunk);
        }
      } catch (error) { failed = true; throw error; }
      finally { await file.close(); if (failed) await rm(destinationPath, { force: true }).catch(() => undefined); }
      return byteSize;
    },
  };
}
