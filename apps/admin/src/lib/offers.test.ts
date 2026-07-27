import { describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";
import { offersApi } from "./offers";

vi.mock("./api", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));
const mockedApi = vi.mocked(api);

const offer = {
  id: "offer-1",
  productId: "product-1",
  customerName: "Jane Collector",
  customerEmail: "jane@example.com",
  offeredAmount: 900,
  currency: "EUR",
  status: "pending",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as any;

describe("admin offers API client", () => {
  it("list() sends GET /api/offers and returns the response unchanged", async () => {
    mockedApi.get.mockResolvedValueOnce([offer]);
    const result = await offersApi.list();
    expect(mockedApi.get).toHaveBeenCalledWith("/api/offers");
    expect(result).toEqual([offer]);
  });

  it("accept() sends POST /api/offers/:id/accept with an empty body", async () => {
    const accepted = { ...offer, status: "accepted" };
    mockedApi.post.mockResolvedValueOnce(accepted);
    const result = await offersApi.accept("offer-1");
    expect(mockedApi.post).toHaveBeenCalledWith("/api/offers/offer-1/accept", {});
    expect(result).toEqual(accepted);
  });

  it("reject() sends POST /api/offers/:id/reject with an empty body", async () => {
    const rejected = { ...offer, status: "rejected" };
    mockedApi.post.mockResolvedValueOnce(rejected);
    const result = await offersApi.reject("offer-1");
    expect(mockedApi.post).toHaveBeenCalledWith("/api/offers/offer-1/reject", {});
    expect(result).toEqual(rejected);
  });

  it("createDraftOrder() sends POST /api/offers/:id/draft-order and returns the created order", async () => {
    const draftOrder = { id: "order-1", orderNumber: "NOC-20260101-000001" };
    mockedApi.post.mockResolvedValueOnce(draftOrder);
    const result = await offersApi.createDraftOrder("offer-1");
    expect(mockedApi.post).toHaveBeenCalledWith("/api/offers/offer-1/draft-order", {});
    expect(result).toEqual(draftOrder);
  });

  it("propagates API failures from list()", async () => {
    mockedApi.get.mockRejectedValueOnce(new ApiError("Not authenticated", 401));
    await expect(offersApi.list()).rejects.toBeInstanceOf(ApiError);
  });

  it("propagates API failures from accept()", async () => {
    mockedApi.post.mockRejectedValueOnce(new ApiError("Offer is already terminal", 400));
    await expect(offersApi.accept("offer-1")).rejects.toBeInstanceOf(ApiError);
  });
});
