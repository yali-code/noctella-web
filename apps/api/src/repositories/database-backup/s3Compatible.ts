import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createReadStream } from "node:fs";
import { open, rm } from "node:fs/promises";
import type { DatabaseBackupObjectMetadata, DatabaseBackupRepository } from "./types";

export interface S3CompatibleBackupConfig {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  prefix: string;
}

export class DatabaseBackupConfigurationError extends Error {
  constructor() { super("Database backup storage is not configured"); this.name = "DatabaseBackupConfigurationError"; }
}

export function readS3CompatibleBackupConfig(env: NodeJS.ProcessEnv = process.env): S3CompatibleBackupConfig {
  const region = env.DATABASE_BACKUP_S3_REGION?.trim();
  const bucket = env.DATABASE_BACKUP_S3_BUCKET?.trim();
  const accessKeyId = env.DATABASE_BACKUP_S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.DATABASE_BACKUP_S3_SECRET_ACCESS_KEY?.trim();
  if (!region || !bucket || !accessKeyId || !secretAccessKey) throw new DatabaseBackupConfigurationError();
  const suppliedPrefix = env.DATABASE_BACKUP_S3_PREFIX?.trim();
  const prefix = (suppliedPrefix || "database-backups").replace(/^\/+|\/+$/g, "");
  const segments = prefix.split("/");
  if (!prefix || prefix.includes("..") || segments.some((segment) => !segment || segment === "." || segment === ".." || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))) {
    throw new DatabaseBackupConfigurationError();
  }
  return {
    endpoint: env.DATABASE_BACKUP_S3_ENDPOINT?.trim() || undefined,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: env.DATABASE_BACKUP_S3_FORCE_PATH_STYLE === "true",
    prefix,
  };
}

export function createS3CompatibleBackupRepository(
  config: S3CompatibleBackupConfig,
  client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  }),
): DatabaseBackupRepository {
  return {
    async upload(localPath, metadata) {
      await client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: metadata.objectKey,
        Body: createReadStream(localPath),
        ContentLength: metadata.byteSize,
        ContentType: "application/vnd.sqlite3",
        Metadata: { sha256: metadata.sha256, "size-bytes": String(metadata.byteSize), "created-at": metadata.createdAt },
      }));
    },
    async head(objectKey) {
      const result = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: objectKey }));
      const contentLength = Number(result.ContentLength);
      const metadataLength = Number(result.Metadata?.["size-bytes"]);
      if (!Number.isSafeInteger(contentLength) || contentLength <= 0 || metadataLength !== contentLength) throw new Error("Database backup remote size metadata is invalid");
      return {
        objectKey,
        byteSize: contentLength,
        sha256: result.Metadata?.sha256 ?? "",
        createdAt: result.Metadata?.["created-at"] ?? "",
      };
    },
    async download(objectKey, destinationPath, maximumBytes) {
      const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: objectKey }));
      if (!result.Body || !(Symbol.asyncIterator in result.Body)) throw new Error("Database backup download failed");
      const file = await open(destinationPath, "wx");
      let byteSize = 0;
      let failed = false;
      try {
        for await (const value of result.Body as AsyncIterable<Uint8Array>) {
          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
          byteSize += chunk.byteLength;
          if (byteSize > maximumBytes) throw new Error("Database backup download exceeded expected size");
          await file.write(chunk);
        }
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        await file.close();
        if (failed) await rm(destinationPath, { force: true }).catch(() => undefined);
      }
      return byteSize;
    },
  };
}
