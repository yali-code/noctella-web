// Sprint 64D: InventoryUseCaseError previously fell through to handleRouteError's generic 500
// branch (it doesn't extend BadRequestError/ConflictError/NotFoundError). Fixed by classifying
// each subtype with a `category` (application/inventory/errors.ts) and mapping that category to
// an HTTP status in routes/errorHandler.ts. Covers both the mapper directly (deterministic,
// exhaustive across every subtype) and one real HTTP round-trip through an actual inventory
// route (routes/stockMovements.ts) to prove the fix holds once errors bubble through a real
// service call, not just in isolation.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ZodError, z } from "zod";
import express from "express";
import request from "supertest";
import { handleRouteError } from "../src/routes/errorHandler";
import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError } from "../src/services/errors";
import {
  InsufficientInventoryError,
  InvalidInventoryQuantityError,
  InvalidSkuError,
  InvalidStockTransferError,
  InventoryAlreadyInitializedError,
  InventoryNotInitializedError,
  InventoryOperationConflictError,
  InventoryVersionConflictError,
  ProductAlreadyExistsError,
  ProductNotFoundApplicationError,
  StockLocationNotFoundApplicationError,
} from "../src/application/inventory/errors";
import { ProductStatus, ProductType } from "@noctella/shared";
import { createTestDb } from "./testDb";
import { createCategory } from "../src/services/categories";
import { createProduct } from "../src/services/products";
import { manualStockAdjustmentSchema } from "../src/validation/stockMovement";

// routes/stockMovements.ts imports the db/client singleton directly (not an injectable
// parameter), so it must be mocked before that route module is ever imported - same pattern as
// returnsRefundsRoutesSprint56B.test.ts. vi.mock factories are hoisted above these imports.
let harnessDb: ReturnType<typeof createTestDb>;
vi.mock("../src/db/client", async () => {
  const { createTestDb: create } = await import("./testDb");
  harnessDb = create();
  return { db: harnessDb, dbRuntime: { driver: "sqlite", db: harnessDb, shutdown: async () => {} } };
});

function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  return res;
}

describe("handleRouteError - InventoryUseCaseError mapping (Sprint 64D, unit)", () => {
  it("maps validation-category inventory errors to 400", () => {
    for (const err of [new InvalidInventoryQuantityError(), new InvalidSkuError(), new InvalidStockTransferError()]) {
      const res = mockRes();
      handleRouteError(err, res);
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: err.message });
    }
  });

  it("maps conflict-category inventory errors to 409", () => {
    for (const err of [
      new ProductAlreadyExistsError(),
      new InventoryAlreadyInitializedError(),
      new InsufficientInventoryError(),
      new InventoryVersionConflictError(),
      new InventoryOperationConflictError(),
    ]) {
      const res = mockRes();
      handleRouteError(err, res);
      expect(res.statusCode).toBe(409);
      expect(res.body).toEqual({ error: err.message });
    }
  });

  it("maps not_found-category inventory errors to 404 (existing NotFoundError semantics)", () => {
    for (const err of [new ProductNotFoundApplicationError(), new InventoryNotInitializedError(), new StockLocationNotFoundApplicationError()]) {
      const res = mockRes();
      handleRouteError(err, res);
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ error: err.message });
    }
  });

  it("never maps a genuine unexpected exception to 400/409 - still 500", () => {
    const res = mockRes();
    handleRouteError(new Error("something truly unexpected broke"), res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
  });

  it("does not change existing non-inventory error mappings", () => {
    const cases: [unknown, number][] = [
      [new UnauthorizedError(), 401],
      [new NotFoundError(), 404],
      [new ConflictError("conflict"), 409],
      [new BadRequestError("bad request"), 400],
    ];
    for (const [err, status] of cases) {
      const res = mockRes();
      handleRouteError(err, res);
      expect(res.statusCode).toBe(status);
    }
    const zodRes = mockRes();
    try {
      z.object({ x: z.string() }).parse({});
    } catch (zodErr) {
      expect(zodErr).toBeInstanceOf(ZodError);
      handleRouteError(zodErr, zodRes);
      expect(zodRes.statusCode).toBe(400);
      expect(zodRes.body.error).toBe("Validation failed");
    }
  });
});

describe("inventory error mapping over real HTTP (Sprint 64D, routes/stockMovements.ts)", () => {
  let app: express.Express;
  let productId: string;

  beforeAll(async () => {
    // Forces the vi.mock("../src/db/client") factory above to run (and populate harnessDb)
    // before it's used - the factory only executes once that module is actually imported.
    await import("../src/db/client");
    const category = await createCategory(harnessDb, { name: "Objects", displayOrder: 0, isActive: true });
    const product = await createProduct(harnessDb, {
      sku: "SKU-ERRMAP-001",
      title: "Error Mapping Object",
      slug: "error-mapping-object",
      type: ProductType.LotItem,
      status: ProductStatus.Published,
      categoryId: category.id,
      customsWarning: false,
      isFeatured: false,
      allowMakeOffer: false,
      allowCashOnDelivery: false,
      showInArchiveAfterSale: false,
      priceEur: 500,
      stockQuantity: 3,
    });
    productId = product.id;

    // Mounts the real routes/stockMovements.ts (its db/client import resolves to harnessDb via
    // the vi.mock above). requirePermission("products.edit") is satisfied by a fixed Owner
    // identity standing in for requireAuth (that boundary is out of scope here - see Sprint 64C).
    const stockMovementsRouter = (await import("../src/routes/stockMovements")).default;
    app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.adminUser = { id: "test-owner", email: "owner@example.com", role: "owner", status: "active" };
      next();
    });
    app.use("/api/stock-movements", stockMovementsRouter);
  });

  it("a previously-500 not-found inventory error now returns a client-facing status, not 500", async () => {
    const res = await request(app).post("/api/stock-movements/adjustments").send({ productId: "does-not-exist", quantityDelta: 1 });
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(404);
  });

  it("existing non-inventory validation mapping is unchanged (malformed query -> 400)", async () => {
    const res = await request(app).get("/api/stock-movements").query({ page: "not-a-number" });
    expect(res.status).toBe(400);
  });

  it("existing successful inventory flow is unchanged", async () => {
    const res = await request(app)
      .post("/api/stock-movements/adjustments")
      .send(manualStockAdjustmentSchema.parse({ productId, quantityDelta: -1, note: "Cycle count" }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ productId, quantityDelta: -1, stockBefore: 3, stockAfter: 2 });
  });
});
