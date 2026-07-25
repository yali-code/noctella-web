// Sprint 69: shared cross-platform apps/api base-directory resolver, extracted from 8 audit
// scripts that previously each defined an identical copy using the host-bound "node:path"
// import (basename/dirname/join), which silently produced a duplicated, mixed-separator suffix
// (e.g. "...apps\api/apps/api") when a Windows-style cwd was checked on a Linux CI runner. See
// src/scripts/auditPathBase.ts for the full explanation.
import { describe, expect, it } from "vitest";
import { resolveAuditBase } from "../src/scripts/auditPathBase";

describe("resolveAuditBase (Sprint 69)", () => {
  it("1. POSIX repository root - appends apps/api using POSIX separators", () => {
    expect(resolveAuditBase("/home/runner/work/noctella-web")).toBe("/home/runner/work/noctella-web/apps/api");
  });

  it("2. POSIX apps/api cwd - returned unchanged", () => {
    expect(resolveAuditBase("/home/runner/work/noctella-web/apps/api")).toBe("/home/runner/work/noctella-web/apps/api");
  });

  it("3. Windows repository root - appends apps\\api using Windows separators, even on a Linux host", () => {
    expect(resolveAuditBase("C:\\Users\\Admin\\noctella-web")).toBe("C:\\Users\\Admin\\noctella-web\\apps\\api");
  });

  it("4. Windows apps/api cwd - returned unchanged, even when this test runs on Linux CI", () => {
    expect(resolveAuditBase("C:\\Users\\Admin\\noctella-web\\apps\\api")).toBe("C:\\Users\\Admin\\noctella-web\\apps\\api");
  });

  it("never produces a mixed-separator path (e.g. C:\\repo/apps/api)", () => {
    const result = resolveAuditBase("C:\\Users\\Admin\\noctella-web");
    expect(result).not.toContain("/");
    expect(result).toBe("C:\\Users\\Admin\\noctella-web\\apps\\api");
  });

  it("does not duplicate the apps/api suffix when already inside apps/api", () => {
    const posixResult = resolveAuditBase("/home/runner/work/noctella-web/apps/api");
    const windowsResult = resolveAuditBase("C:\\Users\\Admin\\noctella-web\\apps\\api");
    expect(posixResult.match(/apps\/api/g)?.length ?? 0).toBe(1);
    expect(windowsResult.match(/apps\\api/g)?.length ?? 0).toBe(1);
  });
});
