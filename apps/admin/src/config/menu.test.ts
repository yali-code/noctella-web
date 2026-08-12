import { describe, expect, it } from "vitest";
import { adminMenuItems } from "./menu";

describe("adminMenuItems (Sprint 97)", () => {
  it("includes the AI Product Intake entry", () => {
    expect(adminMenuItems).toContainEqual({ label: "AI Product Intake", href: "/ai-product-intakes" });
  });

  it("retains the existing AI Drafts entry unchanged", () => {
    expect(adminMenuItems).toContainEqual({ label: "AI Drafts", href: "/ai-drafts" });
  });

  it("includes the Ready to Publish entry (Sprint 136)", () => {
    expect(adminMenuItems).toContainEqual({ label: "Ready to Publish", href: "/ready-to-publish" });
  });
});
