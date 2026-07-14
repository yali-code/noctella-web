import { describe, expect, it } from "vitest";
import { mapAudit, mapCapabilities, mapCheckpoint, mapClientMetadata, mapFieldOwnership, mapReadOnlyLabel, mapVersionStatus, redactErpError } from "./erpIntegration";

describe("ERP integration admin helpers", () => {
  it("maps health/version and mismatch labels", () => { expect(mapVersionStatus({ compatible: true })).toBe("Compatible"); expect(mapVersionStatus({ compatible: false })).toBe("Version mismatch"); });
  it("maps capabilities and read-only label", () => { expect(mapReadOnlyLabel({ writesEnabled: false })).toContain("Read-only"); expect(mapCapabilities({ modules: [{ name:"Inventory", mode:"ReadOnly" }] })[0].mode).toBe("ReadOnly"); });
  it("maps client metadata without secret rendering", () => { const c=mapClientMetadata({ id:"1", name:"ERP", keyVersion:"v1", isActive:1 }); expect(c.secret).toBeUndefined(); expect(c.lastSeenAt).toBe("Never"); });
  it("maps checkpoint, audit and field ownership", () => { expect(mapCheckpoint({ checkpointToken:"t", acknowledgedAt:"now", clientId:"c" }).token).toBe("t"); expect(mapAudit({ action:"A", result:"OK" }).result).toBe("OK"); expect(mapFieldOwnership([{ erpField:"availableQuantity", owner:"Derived", currentSprintMode:"ReadOnly", dataLossRisk:"None" }])[0].owner).toBe("Derived"); });
  it("redacts safe errors", () => { expect(redactErpError("erp_key=abc secret:xyz token=123")).not.toContain("abc"); });
});
