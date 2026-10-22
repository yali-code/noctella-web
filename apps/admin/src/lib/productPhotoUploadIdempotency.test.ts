// @vitest-environment jsdom
// #424: stable per-logical-upload Idempotency-Key for the W2 product photo route.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { createProductPhotoUploadKeys, productPhotoApi, productPhotoUploadFailureIsAmbiguous } from "./productPhotos";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const photo = (name = "front.jpg") => new File(["bytes"], name, { type: "image/jpeg" });
// Server contract (apps/api/src/routes/productPhotoUpload.ts): /^[A-Za-z0-9_-]{16,128}$/.
const SERVER_KEY = /^[A-Za-z0-9_-]{16,128}$/;

describe("product photo upload keys", () => {
  it("one key per logical upload: stable for the same file and alt text, distinct otherwise, server-valid", () => {
    const keys = createProductPhotoUploadKeys();
    const a = photo("a.jpg"), b = photo("a.jpg");
    const key = keys.keyFor(a, "Front");
    expect(key).toMatch(SERVER_KEY);
    expect(keys.keyFor(a, "Front")).toBe(key);
    expect(keys.keyFor(b, "Front")).not.toBe(key); // a distinct selection of identical bytes is a distinct upload
  });

  it("changing the alt text starts a new logical upload (the server binds the key to it)", () => {
    const keys = createProductPhotoUploadKeys();
    const a = photo();
    const key = keys.keyFor(a, "Front");
    expect(keys.keyFor(a, "Back")).not.toBe(key);
  });

  it("keeps the key after an ambiguous failure and releases it after success or a definitive rejection", () => {
    const keys = createProductPhotoUploadKeys();
    const lost = photo(), down = photo(), busy = photo(), done = photo(), invalid = photo(), conflict = photo();
    const initial = [lost, down, busy, done, invalid, conflict].map((f) => keys.keyFor(f, ""));
    keys.settle(lost, new TypeError("Failed to fetch"));
    keys.settle(down, new ApiError("Service Unavailable", 503));
    keys.settle(busy, new ApiError("in progress", 409, undefined, "PHOTO_OPERATION_IN_PROGRESS"));
    keys.settle(done);
    keys.settle(invalid, new ApiError("Invalid image", 400, undefined, "PHOTO_UPLOAD_INVALID"));
    keys.settle(conflict, new ApiError("review", 409, undefined, "PHOTO_OPERATION_REVIEW"));
    const next = [lost, down, busy, done, invalid, conflict].map((f) => keys.keyFor(f, ""));
    expect(next.slice(0, 3)).toEqual(initial.slice(0, 3));
    next.slice(3).forEach((key, i) => expect(key).not.toBe(initial[3 + i]));
  });

  it("classifies failures conservatively: only a definitive server answer ends the identity", () => {
    for (const ambiguous of [new TypeError("network"), new ApiError("x", 500), new ApiError("x", 502), new ApiError("x", 408), new ApiError("x", 429),
      new ApiError("x", 409, undefined, "PHOTO_OPERATION_IN_PROGRESS"), new ApiError("x", 409, undefined, "PHOTO_OPERATION_FENCE_LOST")])
      expect(productPhotoUploadFailureIsAmbiguous(ambiguous)).toBe(true);
    for (const definitive of [new ApiError("x", 400), new ApiError("x", 403), new ApiError("x", 413),
      new ApiError("x", 409, undefined, "PHOTO_UPLOAD_IDEMPOTENCY_CONFLICT"), new ApiError("x", 409, undefined, "PHOTO_OPERATION_REVIEW"), new ApiError("x", 409)])
      expect(productPhotoUploadFailureIsAmbiguous(definitive)).toBe(false);
  });
});

describe("productPhotoApi.upload", () => {
  const ok = () => vi.fn().mockResolvedValue({ ok: true, status: 201, headers: new Headers({ "content-type": "application/json" }), json: () => Promise.resolve({ id: "p" }) });

  it("sends the Idempotency-Key header with the multipart body and credentials", async () => {
    const fetchMock = ok();
    vi.stubGlobal("fetch", fetchMock);
    await productPhotoApi.upload("prod-1", photo(), "Front", "key-0000000000000001");
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/products\/prod-1\/photos$/);
    expect(options.headers).toEqual({ "Idempotency-Key": "key-0000000000000001" });
    expect(options.credentials).toBe("include");
    expect((options.body as FormData).get("altText")).toBe("Front");
  });

  it("sends no extra header without a key (unchanged request shape)", async () => {
    const fetchMock = ok();
    vi.stubGlobal("fetch", fetchMock);
    await productPhotoApi.upload("prod-1", photo());
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toBeUndefined();
  });

  it("surfaces the server's machine-readable code so retry boundaries can be decided", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 409, statusText: "Conflict", headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ error: "This photo upload is already in progress", code: "PHOTO_OPERATION_IN_PROGRESS" }) }));
    await expect(productPhotoApi.upload("prod-1", photo(), undefined, "key-0000000000000001")).rejects.toMatchObject({ status: 409, code: "PHOTO_OPERATION_IN_PROGRESS" });
  });
});
