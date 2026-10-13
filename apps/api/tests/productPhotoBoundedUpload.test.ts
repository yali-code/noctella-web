import { mkdtemp, readFile, readdir, rm, mkdir, writeFile, truncate, stat, link } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Writable } from "node:stream";
import express from "express";
import request from "supertest";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PhotoUploadAdmission } from "../src/services/photoUploadAdmission";
import { createProductPhotoUploadHandler, type ProductPhotoUploadOptions } from "../src/routes/productPhotoUpload";
import { LocalStagedProductPhotoStorage } from "../src/services/stagedProductPhotoStorage";
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true, maxRetries: 3 }))); });
async function temp() { const root = await mkdtemp(path.join(os.tmpdir(), "noctella-bounded-photo-")); dirs.push(root); return root; }
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error("Condition did not settle");
}
async function fixture(options: Partial<ProductPhotoUploadOptions> = {}) {
  const root = await temp();
  const admission = new PhotoUploadAdmission();
  const upload = vi.fn(async (_id, file) => {
    expect(file.buffer).toBeUndefined();
    expect(path.basename(file.path)).toBe("input");
    expect((await stat(file.path)).size).toBe(file.size);
    return { id: "photo", sizeBytes: file.size, altText: "front" };
  });
  const check = vi.fn(async () => {});
  const app = express();
  app.post("/products/:id/photos", (req, res, next) => req.headers["x-auth"] === "yes" ? next() : res.status(401).json({ error: "Unauthorized" }), createProductPhotoUploadHandler({ root, admission, assertProduct: check, upload, ...options }));
  return { app, root, admission, upload, check };
}
function post(app: express.Express) { return request(app).post("/products/p/photos").set("x-auth", "yes"); }

describe("bounded product admission", () => {
  it("reserves only three requests and runs one transform FIFO", async () => {
    const gate = new PhotoUploadAdmission();
    const leases = [gate.reserve(), gate.reserve(), gate.reserve()];
    expect(() => gate.reserve()).toThrow("capacity");
    const hold = deferred(); const order: number[] = [];
    const a = leases[0].run(async () => { order.push(0); await hold.promise; }, new AbortController().signal);
    const b = leases[1].run(async () => { order.push(1); }, new AbortController().signal);
    const c = leases[2].run(async () => { order.push(2); }, new AbortController().signal);
    expect(gate.snapshot()).toMatchObject({ held: 3, active: 1, waiting: 2 });
    hold.resolve(); await Promise.all([a, b, c]); leases.forEach(lease => lease.release());
    expect(order).toEqual([0, 1, 2]); expect(gate.snapshot()).toMatchObject({ held: 0, active: 0, waiting: 0 });
  });
  it("cancels queued work without releasing still-running native work", async () => {
    const gate = new PhotoUploadAdmission(); const first = gate.reserve(), second = gate.reserve();
    const hold = deferred(), abort = new AbortController();
    const a = first.run(async () => { await hold.promise; }, abort.signal);
    const waitingAbort = new AbortController();
    const b = second.run(async () => { throw Error("Must not run"); }, waitingAbort.signal);
    const rejected = expect(b).rejects.toMatchObject({ code: "PHOTO_UPLOAD_ABORTED" });
    waitingAbort.abort(); abort.abort(); await rejected; second.release();
    expect(gate.snapshot()).toMatchObject({ active: 1, held: 1 });
    expect(() => first.release()).toThrow("active");
    hold.resolve(); await a; first.release(); expect(gate.snapshot().held).toBe(0);
  });
  it("queue timeout and transform alarm fail closed with no early permit release", async () => {
    const gate = new PhotoUploadAdmission({ active: 1, waiters: 2, waitMs: 5, alarmMs: 20 });
    const a = gate.reserve(), b = gate.reserve(), hold = deferred();
    const running = a.run(async () => { await hold.promise; }, new AbortController().signal);
    await expect(b.run(async () => {}, new AbortController().signal)).rejects.toMatchObject({ code: "PHOTO_QUEUE_TIMEOUT" }); b.release();
    await until(() => gate.snapshot().closed);
    expect(gate.snapshot().active).toBe(1); expect(() => gate.reserve()).toThrow();
    hold.resolve(); await running; a.release();
  });
});

describe("bounded private multipart ingress", () => {
  it("auth runs before staging; missing photo keeps the established 400 error", async () => {
    const f = await fixture();
    await request(f.app).post("/products/p/photos").attach("photo", Buffer.from("x"), "x.png").expect(401);
    expect(f.check).not.toHaveBeenCalled(); expect(await readdir(f.root)).toEqual([]);
    const missing = await post(f.app).expect(400); expect(missing.body.error).toBe("Photo file is required");
    expect(await readdir(f.root)).toEqual([]); expect(f.admission.snapshot().held).toBe(0);
  });
  it("stages without a Buffer and ignores client filenames; preserves altText", async () => {
    const f = await fixture();
    await post(f.app).field("altText", "front").attach("photo", Buffer.from("x"), { filename: "../escape.png", contentType: "image/png" }).expect(201);
    expect(f.upload).toHaveBeenCalledWith("p", expect.objectContaining({ size: 1, mimetype: "image/png" }), "front");
    expect(await readdir(f.root)).toEqual([]);
  });
  it("accepts exactly 10 MiB and rejects one byte over it, with cleanup", async () => {
    const f = await fixture();
    await post(f.app).attach("photo", Buffer.alloc(10 * 1024 * 1024), "x.png").expect(201);
    const over = await post(f.app).attach("photo", Buffer.alloc(10 * 1024 * 1024 + 1), "x.png").expect(413);
    expect(over.body.code).toBe("PHOTO_UPLOAD_LIMIT");
    expect(await readdir(f.root)).toEqual([]); expect(f.admission.snapshot().held).toBe(0);
  });
  it.each(["extra-file", "field-overflow", "unknown-field"])("rejects %s before persistence and removes staged files", async mode => {
    const f = await fixture();
    let req = post(f.app).attach("photo", Buffer.from("x"), "x.png");
    if (mode === "extra-file") req = req.attach("photo", Buffer.from("y"), "y.png");
    else if (mode === "field-overflow") req = req.field("altText", "x".repeat(8193));
    else req = req.field("untrusted", "x");
    await req.expect(413); expect(f.upload).not.toHaveBeenCalled(); expect(await readdir(f.root)).toEqual([]);
  });
  it("rejects the fourth request before any parsing or product lookup", async () => {
    const f = await fixture();
    const reservations = [f.admission.reserve(), f.admission.reserve(), f.admission.reserve()];
    const result = await post(f.app).attach("photo", Buffer.alloc(1024), "x.png").expect(503);
    expect(result.headers["retry-after"]).toBe("1"); expect(result.body.code).toBe("PHOTO_CAPACITY_BUSY");
    expect(f.check).not.toHaveBeenCalled(); expect(await readdir(f.root)).toEqual([]);
    reservations.forEach(lease => lease.release());
  });
  it("maps ENOSPC to safe 503 and closes admission after removing partial input", async () => {
    const f = await fixture({ inputWriter: () => new Writable({ write(_chunk, _enc, callback) { callback(Object.assign(new Error("private host path"), { code: "ENOSPC" })); } }) });
    const result = await post(f.app).attach("photo", Buffer.from("x"), "x.png").expect(503);
    expect(JSON.stringify(result.body)).not.toContain("private host"); expect(f.upload).not.toHaveBeenCalled();
    expect(await readdir(f.root)).toEqual([]); expect(f.admission.snapshot()).toMatchObject({ held: 0, closed: true });
  });
  it("retains crash orphans and fails safe on exhausted staging budget", async () => {
    const root = await temp(); await mkdir(path.join(root, "orphan")); const orphan = path.join(root, "orphan", "input"); await writeFile(orphan, "x"); await truncate(orphan, 128 * 1024 * 1024 + 1);
    const f = await fixture({ root });
    await post(f.app).attach("photo", Buffer.from("x"), "x.png").expect(503);
    expect((await stat(orphan)).size).toBe(128 * 1024 * 1024 + 1); expect(f.upload).not.toHaveBeenCalled();
  });
  it("cleanup failure retains saved success and closes future admission instead of deleting canonical data", async () => {
    const f = await fixture({ removeDir: vi.fn(async () => { throw Object.assign(new Error("cleanup"), { code: "EACCES" }); }) as any });
    await post(f.app).attach("photo", Buffer.from("x"), "x.png").expect(201);
    expect((await readdir(f.root)).length).toBe(1); expect(f.admission.snapshot().closed).toBe(true);
    await post(f.app).attach("photo", Buffer.from("x"), "x.png").expect(503);
  });
  it.each(["abort", "timeout"])("settles %s during a partial multipart body and removes all input", async mode => {
    const f = await fixture({ receiveMs: mode === "timeout" ? 30 : 30000 });
    const server = f.app.listen(0); await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address() as { port: number };
    const result = new Promise<number>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: address.port, path: "/products/p/photos", method: "POST", headers: { "x-auth": "yes", "content-type": "multipart/form-data; boundary=photo-boundary", "content-length": "100000" } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
      req.on("error", () => resolve(0));
      req.write('--photo-boundary\r\nContent-Disposition: form-data; name="photo"; filename="x.png"\r\nContent-Type: image/png\r\n\r\npartial');
      if (mode === "abort") void until(async () => (await readdir(f.root)).length > 0).then(() => req.destroy());
    });
    try {
      const status = await result; if (mode === "timeout") expect(status).toBe(408);
      await until(() => f.admission.snapshot().held === 0); expect(await readdir(f.root)).toEqual([]);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 10000);
});

describe("staged processing and publication", () => {
  async function input(bytes: Buffer, mimetype = "image/png") {
    const root = await temp(), workDir = path.join(root, "stage"), canonical = path.join(root, "canonical");
    await mkdir(workDir); await writeFile(path.join(workDir, "input"), bytes);
    return { root, canonical, workDir, file: { path: path.join(workDir, "input"), workDir, mimetype, size: bytes.length, signal: new AbortController().signal } };
  }
  it.each(["jpeg", "png", "webp"] as const)("streams %s with the existing recipe dimensions and metadata", async format => {
    const bytes = await sharp({ create: { width: 2500, height: 1250, channels: 4, background: { r: 100, g: 90, b: 80, alpha: 0.5 } } }).toFormat(format).toBuffer();
    const f = await input(bytes, "image/" + format);
    const saved = await new LocalStagedProductPhotoStorage(f.canonical).saveStagedProductPhoto(f.file);
    expect(saved).toMatchObject({ width: 2000, height: 1000, mimeType: "image/webp", sizeBytes: bytes.length });
    expect(await sharp(path.join(f.canonical, saved.filename)).metadata()).toMatchObject({ format: "webp", width: 2000, height: 1000 });
    expect(await sharp(path.join(f.canonical, path.basename(saved.thumbnailUrl))).metadata()).toMatchObject({ width: 400, height: 200 });
  });
  it("accepts 24 MP but rejects over-pixel, excessive edge and malformed inputs", async () => {
    const accepted = await input(await sharp({ create: { width: 6000, height: 4000, channels: 3, background: "white" } }).png().toBuffer());
    await expect(new LocalStagedProductPhotoStorage(accepted.canonical).saveStagedProductPhoto(accepted.file)).resolves.toMatchObject({ width: 2000 });
    for (const [width, height] of [[6000, 4001], [12001, 1]]) {
      const f = await input(await sharp({ create: { width, height, channels: 3, background: "white" } }).png().toBuffer());
      await expect(new LocalStagedProductPhotoStorage(f.canonical).saveStagedProductPhoto(f.file)).rejects.toMatchObject({ code: "PHOTO_PIXEL_LIMIT" });
      await expect(stat(f.canonical)).rejects.toMatchObject({ code: "ENOENT" });
    }
    const f = await input(Buffer.from("invalid"));
    await expect(new LocalStagedProductPhotoStorage(f.canonical).saveStagedProductPhoto(f.file)).rejects.toMatchObject({ code: "PHOTO_UPLOAD_INVALID" });
  }, 30000);
  it("rolls back only this request's published main if thumbnail publication collides", async () => {
    const f = await input(await sharp({ create: { width: 20, height: 10, channels: 3, background: "blue" } }).png().toBuffer());
    let calls = 0, existing = "";
    const publish: typeof link = async (src, dest) => {
      if (++calls === 1) return link(src, dest);
      existing = String(dest); await writeFile(existing, "pre-existing");
      throw Object.assign(new Error("collision"), { code: "EEXIST" });
    };
    await expect(new LocalStagedProductPhotoStorage(f.canonical, publish).saveStagedProductPhoto(f.file)).rejects.toMatchObject({ code: "PHOTO_STORAGE_UNAVAILABLE" });
    expect(await readFile(existing, "utf8")).toBe("pre-existing"); expect(await readdir(f.canonical)).toHaveLength(1);
  });
});
