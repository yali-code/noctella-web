import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { deleteManagedFile, statManagedFile } from "./managedFileDeletion";
import { NotFoundError } from "./errors";

/**
 * PHASE-2A: private storage for uploaded invoice files. Same placement as AI-intake staged photos
 * (aiIntakePhotoStorage.ts reads AI_INTAKE_PHOTO_DIR in its own module): the root comes from
 * INVOICE_FILE_DIR, read at call time. Unlike staged photos there is no fallback directory - when the
 * variable is unset every upload and read fails closed with a generic error. Production intent:
 * /var/data/invoices on the persistent disk (not configured by this module).
 *
 * Layout: <INVOICE_FILE_DIR>/<cost_set_id>/<intake_id>.<ext>. Both segments are server-generated ids,
 * never client input; the client file name is never used as a path. Files are never deleted by
 * cancellation - removeOwnUnpublished exists only to clean up a file this module just wrote when the
 * database insert that should own it failed.
 */
export class InvoiceFileStorageNotConfiguredError extends Error {
  constructor() { super("Invoice file storage is not configured"); this.name = "InvoiceFileStorageNotConfiguredError"; }
}

export interface StoredInvoiceFile { relativePath: string; sha256: string; sizeBytes: number }

export interface InvoiceFileStorage {
  save(input: { costSetId: string; intakeId: string; ext: string; bytes: Buffer }): Promise<StoredInvoiceFile>;
  /** Absolute path of a stored regular file, for streaming only; never returned to a client. */
  resolveForRead(relativePath: string): Promise<string>;
  removeOwnUnpublished(relativePath: string): Promise<void>;
}

const SEGMENT = /^[A-Za-z0-9-]{1,64}$/;
const FILE_NAME = /^([A-Za-z0-9-]{1,64})\.(pdf|jpg|png)$/;

export function invoiceFileRoot(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.INVOICE_FILE_DIR?.trim();
  if (!raw) throw new InvoiceFileStorageNotConfiguredError();
  return path.resolve(raw);
}

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function splitRelativePath(relativePath: string): { dir: string; file: string } {
  const parts = relativePath.split("/");
  if (parts.length !== 2 || !SEGMENT.test(parts[0]) || !FILE_NAME.test(parts[1])) throw new NotFoundError("Invoice file not found");
  return { dir: parts[0], file: parts[1] };
}

export class LocalInvoiceFileStorage implements InvoiceFileStorage {
  /** Root defaults to INVOICE_FILE_DIR resolved per call; tests may pass an isolated directory. */
  constructor(private readonly rootOverride?: string) {}

  private root(): string { return this.rootOverride ?? invoiceFileRoot(); }

  async save(input: { costSetId: string; intakeId: string; ext: string; bytes: Buffer }): Promise<StoredInvoiceFile> {
    const root = this.root();
    const fileName = `${input.intakeId}.${input.ext}`;
    if (!SEGMENT.test(input.costSetId) || !FILE_NAME.test(fileName)) throw new Error("Invalid invoice file key");
    const dir = path.join(root, input.costSetId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Invoice file directory is unsafe");
    // Atomic publish: exclusive temp file in the same directory -> write -> fsync -> rename.
    const partial = path.join(dir, `.${input.intakeId}.${randomUUID()}.partial`);
    const target = path.join(dir, fileName);
    try {
      const handle = await open(partial, "wx", 0o600);
      try { await handle.writeFile(input.bytes); await handle.sync(); } finally { await handle.close(); }
      await rename(partial, target);
    } catch (error) {
      await rm(partial, { force: true }).catch(() => undefined);
      throw error;
    }
    if (process.platform === "linux") {
      const directory = await open(dir, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
    return { relativePath: `${input.costSetId}/${fileName}`, sha256: sha256Hex(input.bytes), sizeBytes: input.bytes.length };
  }

  async resolveForRead(relativePath: string): Promise<string> {
    const { dir, file } = splitRelativePath(relativePath);
    const setDir = path.join(this.root(), dir);
    let info;
    try { info = await lstat(setDir); } catch (err: any) {
      if (err?.code === "ENOENT") throw new NotFoundError("Invoice file not found");
      throw err;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Invoice file could not be read");
    const stat = await statManagedFile(setDir, file);
    if (stat.disposition === "already_absent") throw new NotFoundError("Invoice file not found");
    if (stat.disposition !== "regular_file") throw new Error("Invoice file could not be read");
    return stat.path!;
  }

  async removeOwnUnpublished(relativePath: string): Promise<void> {
    const { dir, file } = splitRelativePath(relativePath);
    await deleteManagedFile(path.join(this.root(), dir), file);
  }
}

export const invoiceFileStorage = new LocalInvoiceFileStorage();
