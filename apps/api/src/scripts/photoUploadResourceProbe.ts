// Disposable synthetic HTTP probe. Never import the app before these environment guards.
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import http from "node:http";
import path from "node:path";

export async function runScenario(config: any) {
  if (process.platform !== "linux" || process.env.PRODUCT_PHOTO_DIR !== "/work/photos" || process.env.TMPDIR !== "/work/tmp") throw Error("Disposable Linux environment required");
  Object.assign(process.env, { NODE_ENV: "test", DATABASE_DRIVER: "sqlite", DATABASE_URL: "/work/api.sqlite", PRODUCT_PHOTO_DISK_STAGING_ENABLED: "true", AI_INTAKE_PHOTO_DIR: "/work/intake", MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"), MARKETPLACE_OAUTH_STATE_SECRET: "offline-probe-state", ADMIN_APP_ORIGIN: "http://localhost:3001", STOREFRONT_APP_ORIGIN: "http://localhost:3000", SCHEDULER_AUTH_TOKEN: "offline-probe-scheduler" });
  const { AdminRole, ProductType, ProductStatus } = await import("@noctella/shared");
  const app = (await import("../app")).default;
  const { db, dbRuntime } = await import("../db/client");
  const { createAdminUser, login } = await import("../services/adminAuth");
  const { SESSION_COOKIE_NAME } = await import("../auth/cookies");
  const { createCategory } = await import("../services/categories");
  const { createProduct } = await import("../services/products");
  const { productPhotos, outboxEvents } = await import("../db/schema");
  const { productPhotoAdmission } = await import("../services/photoUploadAdmission");
  await createAdminUser(db, { email: "synthetic@offline.test", role: AdminRole.ProductEditor, password: "offline-password-123" });
  const session = await login(db, { email: "synthetic@offline.test", password: "offline-password-123" });
  const category = await createCategory(db, { name: "Synthetic", displayOrder: 0, isActive: true });
  const product = await createProduct(db, { sku: "OFFLINE", title: "Synthetic", type: ProductType.UniqueItem, status: ProductStatus.Draft, categoryId: category.id, priceEur: 10, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(r => server.once("listening", r));
  const port = (server.address() as import("node:net").AddressInfo).port;
  let peak = process.memoryUsage();
  const sample = () => { const current = process.memoryUsage(); for (const key of Object.keys(current) as (keyof typeof current)[]) peak[key] = Math.max(peak[key], current[key]); };
  const baseline = { memory: process.memoryUsage(), cgroupCurrent: Number(await fs.readFile("/sys/fs/cgroup/memory.current", "utf8")) };
  const sampling = setInterval(sample, 10), started = Date.now();
  const operations: any[] = [];
  async function upload(index: number) {
    const fixtureName = config.scenario.fixtures[index % config.scenario.fixtures.length];
    const fixture = config.fixtures.find((item: any) => item.name === fixtureName);
    if (!fixture) throw Error("Missing fixture");
    const file = path.join("/fixtures", path.basename(fixture.file));
    const size = (await fs.stat(file)).size;
    const mime = fixtureName.startsWith("png") ? "image/png" : fixtureName.startsWith("webp") ? "image/webp" : "image/jpeg";
    const start = Date.now(), boundary = "noctella-offline-boundary";
    const head = Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="photo"; filename="synthetic"\r\nContent-Type: ' + mime + '\r\n\r\n');
    const tail = Buffer.from('\r\n--' + boundary + '--\r\n');
    const response = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/products/" + product.id + "/photos", headers: { Cookie: SESSION_COOKIE_NAME + "=" + session.rawToken, "Content-Type": "multipart/form-data; boundary=" + boundary, "Content-Length": head.length + size + tail.length } }, res => {
        let text = "";
        res.on("data", chunk => { text += chunk.toString(); if (text.length > 16384) res.destroy(Error("Response too large")); });
        res.on("error", reject); res.on("end", () => { try { resolve({ status: res.statusCode!, body: JSON.parse(text) }); } catch (e) { reject(e); } });
      });
      req.on("error", reject);
      req.write(head);
      // An early overload response may close the request while its input stream is still flowing.
      const stream = createReadStream(file);
      stream.on("error", reject);
      req.once("response", () => { stream.unpipe(req); stream.destroy(); if (!req.writableEnded) req.end(); });
      stream.pipe(req, { end: false }); stream.once("end", () => req.end(tail));
    });
    const expectedInvalid = fixtureName === "invalid-random-bytes" || fixtureName === "png-stress-144mp";
    const overloaded = config.scenario.concurrency === 4 && response.status === 503 && response.body.code === "PHOTO_CAPACITY_BUSY";
    const asExpected = overloaded || (expectedInvalid ? response.status === 400 : response.status === 201);
    operations.push({ index, fixture: fixtureName, status: response.status, code: response.body.code, ok: response.status === 201, asExpected, durationMs: Date.now() - start });
  }
  try {
    let index = 0;
    await Promise.all(Array.from({ length: config.scenario.concurrency }, async () => { while (index < config.scenario.ops) await upload(index++); }));
    sample();
    const rows = await db.select().from(productPhotos), events = await db.select().from(outboxEvents);
    const successes = operations.filter(op => op.ok).length;
    if (!config.scenario.fixtures.includes("invalid-random-bytes") && !config.scenario.fixtures.includes("png-stress-144mp") && !successes) throw Error("No successful candidate transforms");
    if (rows.length !== successes || events.length !== successes || productPhotoAdmission.snapshot().held !== 0) throw Error("Persistence/admission mismatch");
    if (config.scenario.fixtures.some((name: string) => name === "invalid-random-bytes" || name === "png-stress-144mp") && !operations.some(op => op.status === 400)) throw Error("Missing invalid-image rejection");
    const files = await fs.readdir("/work/photos");
    const tmpDirFiles = [...await fs.readdir("/work/tmp"), ...await fs.readdir("/work/.product-photo-upload-staging").catch(() => [])];
    return { scenario: config.scenario, operations, baseline, peak, peakMaxRss: process.resourceUsage().maxRSS * 1024, totalDurationMs: Date.now() - started, leftovers: { photoDirFiles: files.length, expectedPhotoDirFiles: successes * 2, tmpDirFiles }, scope: "real authenticated product route and isolated SQLite; in-process streaming client; not soak or shared Sharp acceptance" };
  } finally { clearInterval(sampling); await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); await dbRuntime.shutdown(); }
}
