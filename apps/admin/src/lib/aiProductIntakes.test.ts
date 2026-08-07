// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiIntakeFieldDecision } from "@noctella/shared";
import * as apiLib from "./api";
import { ApiError } from "./api";
import { aiProductIntakesApi } from "./aiProductIntakes";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("aiProductIntakesApi (Sprint 97)", () => {
  it("list() calls GET with page/pageSize/status query params", async () => {
    const spy = vi.spyOn(apiLib.api, "get").mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    await aiProductIntakesApi.list({ page: 2, pageSize: 10, status: "open" });
    expect(spy).toHaveBeenCalledWith("/api/ai-product-intakes?page=2&pageSize=10&status=open");
  });

  it("list() omits undefined params", async () => {
    const spy = vi.spyOn(apiLib.api, "get").mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    await aiProductIntakesApi.list();
    expect(spy).toHaveBeenCalledWith("/api/ai-product-intakes");
  });

  it("create() posts an empty body", async () => {
    const spy = vi.spyOn(apiLib.api, "post").mockResolvedValue({});
    await aiProductIntakesApi.create();
    expect(spy).toHaveBeenCalledWith("/api/ai-product-intakes", {});
  });

  it("get() fetches the exact intake path", async () => {
    const spy = vi.spyOn(apiLib.api, "get").mockResolvedValue({});
    await aiProductIntakesApi.get("intake-1");
    expect(spy).toHaveBeenCalledWith("/api/ai-product-intakes/intake-1");
  });

  it("cancel() sends the reason when provided, and an empty body when omitted", async () => {
    const spy = vi.spyOn(apiLib.api, "post").mockResolvedValue({});
    await aiProductIntakesApi.cancel("intake-1", "changed my mind");
    expect(spy).toHaveBeenCalledWith("/api/ai-product-intakes/intake-1/cancel", { cancellationReason: "changed my mind" });
    await aiProductIntakesApi.cancel("intake-1");
    expect(spy).toHaveBeenLastCalledWith("/api/ai-product-intakes/intake-1/cancel", {});
  });

  it("listPhotos() fetches the exact photos path", async () => {
    const spy = vi.spyOn(apiLib.api, "get").mockResolvedValue([]);
    await aiProductIntakesApi.listPhotos("intake-1");
    expect(spy).toHaveBeenCalledWith("/api/ai-product-intakes/intake-1/photos");
  });

  it("uploadPhoto() sends the file under the 'photo' multipart field via uploadForm", async () => {
    const spy = vi.spyOn(apiLib, "uploadForm").mockResolvedValue({});
    const file = new File(["bytes"], "a.png", { type: "image/png" });
    await aiProductIntakesApi.uploadPhoto("intake-1", file);
    expect(spy).toHaveBeenCalledTimes(1);
    const [path, form] = spy.mock.calls[0];
    expect(path).toBe("/api/ai-product-intakes/intake-1/photos");
    expect((form as FormData).get("photo")).toBe(file);
  });

  it("deletePhoto() calls DELETE on the exact photo path", async () => {
    const spy = vi.spyOn(apiLib.api, "delete").mockResolvedValue(undefined);
    await aiProductIntakesApi.deletePhoto("intake-1", "photo-1");
    expect(spy).toHaveBeenCalledWith("/api/ai-product-intakes/intake-1/photos/photo-1");
  });

  it("generateProposal() posts to the exact generate path", async () => {
    const spy = vi.spyOn(apiLib.api, "post").mockResolvedValue({});
    await aiProductIntakesApi.generateProposal("intake-1");
    expect(spy).toHaveBeenCalledWith("/api/ai-product-intakes/intake-1/generate", {});
  });

  it("getProposal() fetches the exact proposal path", async () => {
    const spy = vi.spyOn(apiLib.api, "get").mockResolvedValue({});
    await aiProductIntakesApi.getProposal("intake-1");
    expect(spy).toHaveBeenCalledWith("/api/ai-product-intakes/intake-1/proposal");
  });

  it("updateFieldReview() PATCHes the exact field path with decision/expectedUpdatedAt/value", async () => {
    const spy = vi.spyOn(apiLib.api, "patch").mockResolvedValue({});
    await aiProductIntakesApi.updateFieldReview("intake-1", "title", AiIntakeFieldDecision.Edited, "2026-01-01T00:00:00.000Z", "New Title");
    expect(spy).toHaveBeenCalledWith("/api/ai-product-intakes/intake-1/proposal/fields/title", {
      decision: AiIntakeFieldDecision.Edited,
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
      value: "New Title",
    });
  });

  it("updateFieldReview() omits value when not provided (e.g. Pending reset)", async () => {
    const spy = vi.spyOn(apiLib.api, "patch").mockResolvedValue({});
    await aiProductIntakesApi.updateFieldReview("intake-1", "title", AiIntakeFieldDecision.Pending, "2026-01-01T00:00:00.000Z");
    expect(spy).toHaveBeenCalledWith("/api/ai-product-intakes/intake-1/proposal/fields/title", {
      decision: AiIntakeFieldDecision.Pending,
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("saveAsDraft() posts the exact canonical payload", async () => {
    const spy = vi.spyOn(apiLib.api, "post").mockResolvedValue({});
    const input = { sku: "SKU-1", categoryId: "cat-1", type: "unique_item", priceEur: 10, stockQuantity: 1, expectedProposalUpdatedAt: "t" };
    await aiProductIntakesApi.saveAsDraft("intake-1", input);
    expect(spy).toHaveBeenCalledWith("/api/ai-product-intakes/intake-1/save-as-draft", input);
  });

  it("acceptIntoStock() posts the exact Stock Acceptance payload (no sku field)", async () => {
    const spy = vi.spyOn(apiLib.api, "post").mockResolvedValue({});
    const input = { categoryId: "cat-1", type: "unique_item", priceEur: 10, stockQuantity: 1, brand: "Acme", expectedProposalUpdatedAt: "t" };
    await aiProductIntakesApi.acceptIntoStock("intake-1", input);
    expect(spy).toHaveBeenCalledWith("/api/ai-product-intakes/intake-1/stock-acceptance", input);
  });

  it("finalizePhotos() always sends an explicit primaryIntakePhotoId when provided", async () => {
    const spy = vi.spyOn(apiLib.api, "post").mockResolvedValue({});
    await aiProductIntakesApi.finalizePhotos("intake-1", "photo-1");
    expect(spy).toHaveBeenCalledWith("/api/ai-product-intakes/intake-1/finalize-photos", { primaryIntakePhotoId: "photo-1" });
  });

  it("fetchPhotoContent() fetches with credentials included and returns a Blob", async () => {
    const blob = new Blob(["bytes"], { type: "image/webp" });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(blob), headers: new Headers() });
    vi.stubGlobal("fetch", fetchMock);
    const result = await aiProductIntakesApi.fetchPhotoContent("intake-1", "photo-1");
    expect(result).toBe(blob);
    const [, options] = fetchMock.mock.calls[0];
    expect((options as RequestInit).credentials).toBe("include");
  });

  it("fetchPhotoContent() throws ApiError for a non-success response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ error: "AI intake photo not found" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(aiProductIntakesApi.fetchPhotoContent("intake-1", "photo-1")).rejects.toBeInstanceOf(ApiError);
  });

  it("fetchPhotoContent() never automatically retries on failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Server Error",
      headers: new Headers(),
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(aiProductIntakesApi.fetchPhotoContent("intake-1", "photo-1")).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
