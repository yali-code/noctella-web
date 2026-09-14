import { describe, expect, it } from "vitest";
import { advanceProductEditSession, beginProductEditSession } from "./productEditSession";

describe("Product Card edit session", () => {
  const product = { id: "p1", sku: "ART-000001", updatedAt: "v1" } as any;

  it("captures stable Product identity and the optimistic version", () => {
    expect(beginProductEditSession(product)).toEqual({ productId: "p1", immutableSku: "ART-000001", expectedUpdatedAt: "v1" });
  });

  it("advances only the version after a canonical save response", () => {
    const session = beginProductEditSession(product);
    expect(advanceProductEditSession(session, { id: "p1", sku: "ART-000001", updatedAt: "v2" })).toEqual({
      productId: "p1",
      immutableSku: "ART-000001",
      expectedUpdatedAt: "v2",
    });
  });

  it("fails closed if a response attempts to replace Product identity", () => {
    const session = beginProductEditSession(product);
    expect(() => advanceProductEditSession(session, { id: "p2", sku: "ART-000001", updatedAt: "v2" })).toThrow(/identity changed/);
    expect(() => advanceProductEditSession(session, { id: "p1", sku: "ART-999999", updatedAt: "v2" })).toThrow(/identity changed/);
  });
});
