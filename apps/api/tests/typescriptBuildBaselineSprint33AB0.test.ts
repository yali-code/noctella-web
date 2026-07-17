import { describe, expect, it } from "vitest";
import { ProductStatus, ProductType } from "@noctella/shared";
import { runTypeScriptBuildBaselineAudit } from "../src/scripts/typescriptBuildBaselineAudit";

describe("TypeScript build baseline Sprint 33A-B0", () => {
  it("resolves @noctella/shared from apps/api", () => {
    expect(ProductStatus.Draft).toBe("draft");
    expect(ProductType.UniqueItem).toBe("unique_item");
  });

  it("keeps API compile-time contracts visible", () => {
    expect(runTypeScriptBuildBaselineAudit()).toEqual({
      status: "PASS",
      sharedModuleResolved: true,
      orderRepositoryFields: [
        "id",
        "orderNumber",
        "guestEmail",
        "status",
        "paymentStatus",
        "subtotalAmount",
        "totalAmount",
        "currency",
        "createdAt",
        "updatedAt",
      ],
      orderItemRepositoryFields: ["id", "orderId", "productId", "quantity"],
      productFields: [
        "id",
        "sku",
        "categoryId",
        "collectionId",
        "type",
        "stockQuantity",
      ],
    });
  });
});
