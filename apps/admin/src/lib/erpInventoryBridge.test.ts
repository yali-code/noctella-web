import { describe, expect, it } from "vitest";
import { landedCostCompleteness, mapAvailability, mapCommandStatus, mapPublishReadiness, mapRecentCommands, productPhotosLink, productWorkspaceLink, redactConflictError, workflowLabel } from "./erpInventoryBridge";

describe("ERP inventory bridge admin mapping", () => {
  it("maps workspace cost, workflow, availability, links, readiness and redaction safely", () => {
    expect(landedCostCompleteness({ complete:false, missing:["shippingCostEur"] })).toContain("shippingCostEur");
    expect(workflowLabel("ReadyForPhotos")).toBe("Ready For Photos");
    expect(mapAvailability({ physicalStock:4, reservedStock:1, availableStock:3 })).toMatchObject({ available:3, label:"3 available" });
    expect(mapCommandStatus("Conflict")).toBe("Needs attention");
    expect(redactConflictError({ token:"secret", payload:"raw" })).not.toContain("secret");
    expect(productWorkspaceLink("p1")).toBe("/products/p1/workspace");
    expect(productPhotosLink("p1")).toBe("/products/p1/photos");
    expect(mapPublishReadiness({ ready:false, missing:["photo"] })).toContain("photo");
    expect(mapRecentCommands([{ id:"c1", commandType:"CreateProduct", status:"Succeeded", requestChecksum:"abc", safeResultMetadata:"{}" }])[0]).toMatchObject({ requestChecksum:"redacted", metadata:"safe metadata available" });
  });
});
