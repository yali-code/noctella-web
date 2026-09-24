import { afterEach, describe, expect, it, vi } from "vitest";
import { getOperationalAcquisition } from "./erpInventoryBridge";
import { landedCostCompleteness, mapAvailability, mapCommandStatus, mapPublishReadiness, mapRecentCommands, productPhotosLink, productWorkspaceLink, redactConflictError, workflowLabel } from "./erpInventoryBridge";

describe("ERP inventory bridge admin mapping", () => {
  afterEach(() => vi.restoreAllMocks());
  it("reads acquisition through the encoded same-origin workspace proxy without credentials", async () => {
    const metadata = { purchaseSource: "Kleinanzeigen", provenance: "Private collection" };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(metadata)));
    expect(await getOperationalAcquisition("p/with space")).toEqual(metadata);
    expect(fetchSpy).toHaveBeenCalledExactlyOnceWith("/api/erp/products/p%2Fwith%20space/workspace", { cache: "no-store" });
  });
  it("does not turn a failed workspace read into empty acquisition data", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unavailable", { status: 503 }));
    await expect(getOperationalAcquisition("p")).rejects.toThrow("Operational acquisition could not be loaded.");
  });
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
