import { describe, expect, it } from "vitest";
import { classifyW2UploadIntent, isValidW2UploadIntent, type W2UploadIntent } from "../src/services/w2OperationIdentity";

const intent: W2UploadIntent = {
  tenantId: "tenant-1", actorId: "admin-1", productId: "product-1",
  kind: "W2_PRODUCT_PHOTO_UPLOAD", token: "token_identity_001", sha256: "a".repeat(64), altText: "Photo"
};
describe("W2 pure operation identity contract (no live DB adoption)", () => {
  it("classifies missing, repeated and altered intents correctly", () => {
    expect(classifyW2UploadIntent(null, intent)).toBe("NEW");
    expect(classifyW2UploadIntent({ ...intent }, { ...intent })).toBe("SAME_INTENT");
    for (const field of ["tenantId", "actorId", "productId", "token", "sha256", "altText"] as const) {
      expect(classifyW2UploadIntent(intent, { ...intent, [field]: field === "sha256" ? "b".repeat(64) : "different-value-0001" })).toBe("CONFLICT");
    }
    expect(classifyW2UploadIntent({ ...intent, actorId: 42 }, intent)).toBe("CONFLICT");
  });
  it("rejects malformed and untrusted input fail-closed", () => {
    for (const candidate of [null, {}, [], { ...intent, token: "short" }, { ...intent, sha256: "A".repeat(64) },
      { ...intent, productId: "../escape" }, { ...intent, altText: "x".repeat(501) },
      { ...intent, kind: "W4_AI_FINALIZE" }, { ...intent, tenantId: "" }]) {
      expect(isValidW2UploadIntent(candidate)).toBe(false);
      expect(classifyW2UploadIntent(null, candidate)).toBe("INVALID");
    }
  });
  it("accepts a valid scoped W2 intent without side effects", () => {
    expect(isValidW2UploadIntent(intent)).toBe(true);
  });
});
