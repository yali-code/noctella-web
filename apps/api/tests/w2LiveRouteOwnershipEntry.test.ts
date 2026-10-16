import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { createProductPhotoUploadHandler } from "../src/routes/productPhotoUpload";

afterEach(() => vi.unstubAllEnvs());

function request(headers: Record<string, unknown>, adminUser?: { id: string }) {
  return Object.assign(new EventEmitter(), {
    params: { id: "product-1" }, headers, adminUser,
    complete: true, destroyed: false,
  });
}
function reply() {
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false, destroyed: false, statusCode: 200,
    headers: {} as Record<string, string>, body: undefined as undefined | { code: string },
    status(code: number) { this.statusCode = code; return this; },
    json(body: { code: string }) { this.body = body; this.writableEnded = true; this.emit("response"); return this; },
    setHeader(key: string, value: string) { this.headers[key] = value; },
  });
  return res;
}
async function invoke(req: ReturnType<typeof request>, res: ReturnType<typeof reply>, handler: ReturnType<typeof createProductPhotoUploadHandler>) {
  const done = new Promise<void>(resolve => res.once("response", () => resolve()));
  handler(req as never, res as never, vi.fn());
  await done;
}
it("refuses malformed client token before admission, DB, disk or any write despite injected owner", async () => {
  vi.stubEnv("PHOTO_OWNERSHIP_FENCING_ENABLED", "true");
  const reserve = vi.fn(() => { throw Error("unexpected admission"); });
  const assertProduct = vi.fn(async () => { throw Error("unexpected DB"); });
  const upload = vi.fn(async () => { throw Error("unsafe legacy write"); });
  const fencedUpload = vi.fn(async () => { throw Error("unsafe fenced write"); });
  const handler = createProductPhotoUploadHandler({
    root: "/noctella-w2-untouched-invalid-token",
    admission: { reserve } as never, assertProduct, upload, fencedUpload,
  });
  const req = request({ "idempotency-key": "invalid space" }, { id: "actor-1" }), res = reply();
  await invoke(req, res, handler);
  expect(res.statusCode).toBe(400);
  expect(res.body?.code).toBe("PHOTO_UPLOAD_TOKEN_INVALID");
  expect(reserve).not.toHaveBeenCalled();
  expect(assertProduct).not.toHaveBeenCalled();
  expect(upload).not.toHaveBeenCalled();
  expect(fencedUpload).not.toHaveBeenCalled();
});
it("refuses unauthenticated token-bearing request before admission, DB or writer", async () => {
  vi.stubEnv("PHOTO_OWNERSHIP_FENCING_ENABLED", "true");
  const reserve = vi.fn(() => { throw Error("unexpected admission"); });
  const fencedUpload = vi.fn(async () => { throw Error("unexpected writer"); });
  const handler = createProductPhotoUploadHandler({
    root: "/noctella-w2-untouched-no-actor",
    admission: { reserve } as never,
    assertProduct: vi.fn(async () => { throw Error("unexpected DB"); }),
    upload: vi.fn(async () => { throw Error("legacy write"); }),
    fencedUpload,
  });
  const req = request({ "idempotency-key": "valid-token-00000001" }), res = reply();
  await invoke(req, res, handler);
  expect(res.statusCode).toBe(403);
  expect(res.body?.code).toBe("PHOTO_UPLOAD_ACTOR_REQUIRED");
  expect(reserve).not.toHaveBeenCalled();
  expect(fencedUpload).not.toHaveBeenCalled();
});
