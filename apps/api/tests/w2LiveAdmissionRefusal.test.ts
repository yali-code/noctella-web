import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { createProductPhotoUploadHandler } from "../src/routes/productPhotoUpload";

afterEach(() => vi.unstubAllEnvs());

it("refuses unadopted W2 at the real route boundary before reserve, DB, multipart or disk", async () => {
  vi.stubEnv("PHOTO_OWNERSHIP_FENCING_ENABLED", "true");
  const reserve = vi.fn(() => { throw new Error("admission should not occur"); });
  const assertProduct = vi.fn(async () => { throw new Error("DB should not be read"); });
  const upload = vi.fn(async () => { throw new Error("upload must not be called"); });
  const handler = createProductPhotoUploadHandler({
    admission: { reserve } as never,
    assertProduct,
    upload,
    root: "/not-touched-w2-private-stage"
  });
  const req = Object.assign(new EventEmitter(), {
    params: { id: "p1" }, complete: true, destroyed: false
  });
  const reply = new EventEmitter() as EventEmitter & {
    writableEnded: boolean; destroyed: boolean; statusCode: number;
    headers: Record<string, string>; body?: { code: string };
    status: (code: number) => typeof reply; json: (body: { code: string }) => typeof reply;
    setHeader: (key: string, value: string) => void;
  };
  reply.writableEnded = false;
  reply.destroyed = false;
  reply.statusCode = 200;
  reply.headers = {};
  reply.status = (code) => { reply.statusCode = code; return reply; };
  reply.setHeader = (key, value) => { reply.headers[key] = value; };
  const responded = new Promise<void>((resolve) => {
    reply.json = (body) => { reply.body = body; reply.writableEnded = true; resolve(); return reply; };
  });
  handler(req as never, reply as never, vi.fn());
  await responded;
  expect(reply.statusCode).toBe(503);
  expect(reply.body?.code).toBe("PHOTO_FENCING_WRITER_NOT_ADOPTED");
  expect(reply.headers["Retry-After"]).toBe("1");
  expect(reserve).not.toHaveBeenCalled();
  expect(assertProduct).not.toHaveBeenCalled();
  expect(upload).not.toHaveBeenCalled();
});
