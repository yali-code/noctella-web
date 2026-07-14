import { describe, expect, it } from "vitest";
import { DRY_RUN_WARNING, actionLabel, buildMigrationQuery, downloadableJson, hasExecuteImportAction, mapFieldLoss, piiMaskNotice, redactErpMigrationError, severityLabel, sourceTypeLabel } from "./erpMigration";

describe("ERP migration admin helpers", () => {
  it("maps labels, filters, downloads and safety UI", () => { expect(sourceTypeLabel("LocalStorageJson")).toContain("localStorage"); expect(actionLabel("UpdateCandidate")).toBe("Update Candidate"); expect(severityLabel("Blocking")).toContain("Blocking"); expect(buildMigrationQuery({ entityType:"Product", action:"Create", page:2 })).toContain("page=2"); expect(downloadableJson({ dryRun:true })).toContain("dryRun"); expect(DRY_RUN_WARNING).toContain("no data imported"); expect(hasExecuteImportAction).toBe(false); });
  it("maps field loss and PII display while redacting errors", () => { const preview:any={ summary:{ maskedPiiCount:1 }, entityPreviews:[{ sourceId:"p1", mappedFields:[{ sourceField:"depth", classification:"deferred", risk:"FieldLoss/Deferred" }] }] }; expect(mapFieldLoss(preview)[0].field).toBe("depth"); expect(piiMaskNotice(preview)).toContain("1 fields"); expect(redactErpMigrationError("apiKey=abc jane@example.com")).not.toContain("abc"); expect(redactErpMigrationError("apiKey=abc jane@example.com")).not.toContain("jane@example.com"); });
});
