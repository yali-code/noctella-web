import type { AuthedRequest } from "../auth/permissions";
import { randomUUID } from "node:crypto";
import { digestW2StagedInput } from "../services/w2StagedInputDigest";
import type { Request, RequestHandler } from "express";
import multer from "multer";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Writable } from "node:stream";
import { PhotoUploadAdmission, PhotoUploadError, abortedError, productPhotoAdmission } from "../services/photoUploadAdmission";
import { productPhotoStaticRoot, PRODUCT_PHOTO_MAX_BYTES, PRODUCT_PHOTO_MIME_TYPES } from "../services/photoStorage";
import type { StagedProductPhotoInput } from "../services/stagedProductPhotoStorage";
import { handleRouteError } from "./errorHandler";
import { photoOwnershipFencingEnabled } from "../services/photoOwnershipFencing";

const RESERVATION = 42 * 1024 * 1024;
const STAGING_BUDGET = 128 * 1024 * 1024;
const BODY_LIMIT = PRODUCT_PHOTO_MAX_BYTES + 72 * 1024;
// Finish a bounded raw discard before closing an early rejection. Closing with unread TCP data
// can reset even a valid 503 response. This never parses, stores or concatenates body bytes.
async function discardRejectedBody(req: Request) {
  if (req.complete || req.destroyed) return;
  await new Promise<void>(resolve => {
    let bytes = 0;
    const finish = () => { clearTimeout(timer); req.off("data", data); req.off("end", finish); req.off("aborted", finish); req.off("error", finish); req.pause(); resolve(); };
    const data = (chunk: Buffer) => { bytes += chunk.length; if (bytes >= BODY_LIMIT) finish(); };
    const timer = setTimeout(finish, 1000);
    req.on("data", data); req.once("end", finish); req.once("aborted", finish); req.once("error", finish); req.resume();
  });
}
interface UploadContext { workDir: string; signal: AbortSignal; writes: Promise<unknown>[] }
export interface ProductPhotoUploadOptions {
  root?: string;
  admission?: PhotoUploadAdmission;
  receiveMs?: number;
  assertProduct(productId: string): Promise<unknown>;
  upload(productId: string, file: StagedProductPhotoInput, altText?: string): Promise<unknown>;
  /** Generation-fenced owner only. MUST NOT be wired until durable claim, seal,
   * canonical publication, same-transaction commit and recovery are verified. */
  fencedUpload?: (command: {
    productId: string; actorId: string; operationToken: string;
    sha256: string; altText: string; file: StagedProductPhotoInput;
  }) => Promise<unknown>;
  removeDir?: typeof rm;
  inputWriter?: (file: string) => Writable;
  /**
   * false for staging routes whose upload() writes only a NON-canonical private root (AI intake W3). Such routes are
   * not product-photo writers: fencing neither refuses them nor routes them to the W2 owner. Default true.
   */
  canonical?: boolean;
  /** Authenticated actor for the fenced W2 owner (default: the admin session user). */
  actorId?: (req: Request) => string | undefined;
  /** Best-effort side effect after a committed 201 response (e.g. the ERP audit trail). */
  afterCommit?: (req: Request, value: unknown) => Promise<unknown>;
}
export function createProductPhotoUploadHandler(options: ProductPhotoUploadOptions): RequestHandler {
  const root = path.resolve(options.root ?? path.join(path.dirname(productPhotoStaticRoot), ".product-photo-upload-staging"));
  const admission = options.admission ?? productPhotoAdmission;
  const live = new Set<string>();
  const contexts = new WeakMap<Request, UploadContext>();
  const removeDir = options.removeDir ?? rm;
  const writeInput = options.inputWriter ?? ((file) => createWriteStream(file, { flags: "wx", mode: 0o600 }));
  const parser = multer({
    fileFilter(_req, file, callback) {
      if (!PRODUCT_PHOTO_MIME_TYPES.includes(file.mimetype as any)) callback(new PhotoUploadError(400, "PHOTO_UPLOAD_INVALID", "Product photos must be JPEG, PNG, or WebP images"));
      else callback(null, true);
    },
    limits: { fileSize: PRODUCT_PHOTO_MAX_BYTES + 1, files: 1, fields: 1, fieldSize: 8192, fieldNameSize: 32, parts: 3, headerPairs: 32 },
    storage: {
      _handleFile(req, file, callback) {
        const context = contexts.get(req);
        if (!context || context.signal.aborted) { callback(abortedError()); return; }
        const input = path.join(context.workDir, "input");
        const operation = (async () => {
          await pipeline(file.stream, writeInput(input), { signal: context.signal });
          const size = (await lstat(input)).size;
          return { path: input, size };
        })();
        context.writes.push(operation);
        operation.then(result => callback(null, result), callback);
      },
      // The request owns cleanup; Multer must not race deletion with open writes.
      _removeFile(_req, _file, callback) { callback(null); },
    },
  }).single("photo");

  async function initialize() {
    const canonical = path.resolve(productPhotoStaticRoot);
    const intake = path.resolve(process.env.AI_INTAKE_PHOTO_DIR ?? "uploads/ai-intake-photos-private");
    const overlaps = (a: string, b: string) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
    if (overlaps(root, canonical) || overlaps(root, intake)) throw new PhotoUploadError(503, "PHOTO_STORAGE_UNAVAILABLE", "Photo staging root must be private");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) throw new PhotoUploadError(503, "PHOTO_STORAGE_UNAVAILABLE", "Photo staging root is unsafe");
    let bytes = 0, count = 0;
    async function scan(dir: string, depth: number) {
      if (depth > 4) throw new Error("Unsafe staging tree");
      for (const entry of await readdir(dir)) {
        const file = path.join(dir, entry);
        if (live.has(file)) continue;
        if (++count > 1000) throw new Error("Staging inventory too large");
        const stat = await lstat(file);
        if (stat.isSymbolicLink()) throw new Error("Unsafe staging entry");
        if (stat.isDirectory()) await scan(file, depth + 1);
        else if (stat.isFile()) bytes += stat.size;
        else throw new Error("Unsafe staging entry");
        if (bytes > STAGING_BUDGET) throw new Error("Staging budget exhausted");
      }
    }
    try { await scan(root, 0); } catch { throw new PhotoUploadError(503, "PHOTO_STORAGE_UNAVAILABLE", "Photo staging inventory requires recovery"); }
    if (bytes + admission.snapshot().held * RESERVATION > STAGING_BUDGET) throw new PhotoUploadError(503, "PHOTO_STORAGE_UNAVAILABLE", "Photo staging budget is unavailable");
  }

  return (req, res) => {
    void (async () => {
      let lease: ReturnType<PhotoUploadAdmission["reserve"]> | undefined;
      let workDir: string | undefined, timer: ReturnType<typeof setTimeout> | undefined;
      let context: UploadContext | undefined, value: unknown, error: unknown, committed = false;
      const abort = new AbortController();
      const interrupted = () => { if (!abort.signal.aborted) abort.abort(abortedError()); };
      const closed = () => { if (!res.writableEnded) interrupted(); };
      let bodyBytes = 0;
      const countBody = (chunk: Buffer) => {
        bodyBytes += chunk.length;
        if (bodyBytes > BODY_LIMIT) abort.abort(new PhotoUploadError(413, "PHOTO_UPLOAD_LIMIT", "Photo request exceeds the safety limit"));
      };
      req.once("aborted", interrupted);
      res.once("close", closed);
      try {
        // No legacy-writer fallback when fencing is ON. A verified owning
        // implementation must be injected explicitly before private staging.
        const fencingOn = options.canonical !== false && photoOwnershipFencingEnabled();
        if (fencingOn && !options.fencedUpload)
          throw new PhotoUploadError(503, "PHOTO_FENCING_WRITER_NOT_ADOPTED", "W2 photo upload requires durable ownership adoption");
        const actorId = options.actorId ? options.actorId(req) : (req as AuthedRequest).adminUser?.id;
        if (fencingOn && (!actorId || !/^[A-Za-z0-9:_-]{1,128}$/.test(actorId)))
          throw new PhotoUploadError(403, "PHOTO_UPLOAD_ACTOR_REQUIRED", "Authenticated upload actor is required");
        const suppliedToken = req.headers?.["idempotency-key"];
        if (fencingOn && suppliedToken !== undefined &&
          (typeof suppliedToken !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(suppliedToken)))
          throw new PhotoUploadError(400, "PHOTO_UPLOAD_TOKEN_INVALID", "Invalid photo upload idempotency key");
        const operationToken = fencingOn ? (suppliedToken as string | undefined ?? randomUUID()) : undefined;
        lease = admission.reserve(); // Before DB, body parsing, directory creation or request buffering.
        await options.assertProduct(String(req.params.id));
        await initialize();
        if (abort.signal.aborted) throw abortedError();
        workDir = await mkdtemp(path.join(root, "request-"));
        live.add(workDir);
        context = { workDir, signal: abort.signal, writes: [] };
        contexts.set(req, context);
        timer = setTimeout(() => abort.abort(new PhotoUploadError(408, "PHOTO_UPLOAD_TIMEOUT", "Photo upload timed out")), options.receiveMs ?? 30000);
        await new Promise<void>((resolve, reject) => {
          const stop = () => { req.unpipe(); reject(abort.signal.reason ?? abortedError()); };
          abort.signal.addEventListener("abort", stop, { once: true });
          parser(req, res, err => {
            abort.signal.removeEventListener("abort", stop);
            err ? reject(err) : resolve();
          });
          req.on("data", countBody);
        }).catch(err => {
          if (err instanceof PhotoUploadError || err instanceof multer.MulterError) throw err;
          if ((err as NodeJS.ErrnoException)?.code) throw new PhotoUploadError(503, "PHOTO_STORAGE_UNAVAILABLE", "Photo storage is unavailable");
          throw new PhotoUploadError(400, "PHOTO_UPLOAD_INVALID", "Photo multipart request is invalid");
        });
        clearTimeout(timer); timer = undefined;
        if (abort.signal.aborted) throw abort.signal.reason;
        if (req.file && req.file.size > PRODUCT_PHOTO_MAX_BYTES) throw new PhotoUploadError(413, "PHOTO_UPLOAD_LIMIT", "Product photos must be 10 MB or smaller");
        if (!req.file) throw new PhotoUploadError(400, "PHOTO_UPLOAD_INVALID", "Photo file is required");
        if (Object.keys(req.body ?? {}).some(key => key !== "altText") || (req.body.altText !== undefined && typeof req.body.altText !== "string")) throw new PhotoUploadError(413, "PHOTO_UPLOAD_LIMIT", "Photo multipart fields exceed the safety limit");
        const file: StagedProductPhotoInput = { path: req.file.path, workDir: workDir!, size: req.file.size,
          mimetype: req.file.mimetype, signal: abort.signal, originalname: req.file.originalname,
          actorAdminUserId: actorId };
        value = await lease.run(async () => {
          if (!fencingOn) return options.upload(String(req.params.id), file, req.body.altText);
          // Digest the real private inode. The owning service MUST atomically
          // bind this identity to a generation before publishing canonical bytes.
          const sha256 = await digestW2StagedInput(file, PRODUCT_PHOTO_MAX_BYTES);
          if (abort.signal.aborted) throw abortedError();
          return options.fencedUpload!({
            productId: String(req.params.id), actorId: actorId!,
            operationToken: operationToken!, sha256,
            altText: req.body.altText ?? "", file,
          });
        }, abort.signal);
        committed = true;
      } catch (err) {
        error = err;
        if (/^(ENOSPC|EACCES|EPERM|EIO|EROFS|EMFILE|ENFILE|ENOENT|ELOOP)$/.test((err as NodeJS.ErrnoException)?.code ?? "")) error = new PhotoUploadError(503, "PHOTO_STORAGE_UNAVAILABLE", "Photo storage is unavailable");
        if (error instanceof PhotoUploadError && error.code === "PHOTO_STORAGE_UNAVAILABLE") admission.close();
      } finally {
        if (timer) clearTimeout(timer);
        req.removeListener("data", countBody);
        req.removeListener("aborted", interrupted);
        res.removeListener("close", closed);
        contexts.delete(req);
        await Promise.allSettled(context?.writes ?? []);
        if (workDir) {
          try { await removeDir(workDir, { recursive: true, force: true }); live.delete(workDir); }
          catch {
            admission.close(); // Unknown disk ownership/usage: fail closed until operator recovery.
            console.warn("Photo upload staging cleanup failed; admission closed");
            if (!committed) error = new PhotoUploadError(503, "PHOTO_STORAGE_UNAVAILABLE", "Photo staging cleanup failed");
          }
        }
        lease?.release();
      }
      if (res.destroyed || res.writableEnded) return;
      if (!error) { res.status(201).json(value); if (options.afterCommit) void options.afterCommit(req, value).catch(() => undefined); return; }
      await discardRejectedBody(req);
      if (res.destroyed || res.writableEnded) return;
      // Raw discard is capped in both bytes and time; the connection now closes after the response.
      res.setHeader("Connection", "close");
      // Let Node finish the response and close gracefully; destroying req here can reset an early 503 before it reaches the client.
      if (error instanceof multer.MulterError) error = new PhotoUploadError(413, "PHOTO_UPLOAD_LIMIT", "Photo multipart request exceeds the safety limit");
      if (error instanceof PhotoUploadError) {
        if (error.status === 503) res.setHeader("Retry-After", "1");
        res.status(error.status).json({ error: error.message, code: error.code });
      } else handleRouteError(error, res);
    })().catch(() => {
      admission.close();
      if (!res.headersSent && !res.destroyed) res.status(503).json({ error: "Photo upload is unavailable", code: "PHOTO_STORAGE_UNAVAILABLE" });
    });
  };
}
