import { describe, expect, it } from "vitest";
import { adminMenuItems } from "./menu";

describe("adminMenuItems (Sprint 97)", () => {
  it("includes the AI Product Intake entry", () => {
    expect(adminMenuItems).toContainEqual({ label: "AI Product Intake", href: "/ai-product-intakes" });
  });

  it("retains the existing AI Drafts entry unchanged", () => {
    expect(adminMenuItems).toContainEqual({ label: "AI Drafts", href: "/ai-drafts" });
  });

  it("includes Purchases, Suppliers and Invoice Cost Sets next to Invoices (PHASE-2A)", () => {
    const hrefs = adminMenuItems.map((item) => item.href);
    expect(adminMenuItems).toContainEqual({ label: "Purchases", href: "/purchases" });
    expect(adminMenuItems).toContainEqual({ label: "Suppliers", href: "/suppliers" });
    expect(adminMenuItems).toContainEqual({ label: "Invoice Cost Sets", href: "/invoice-cost-sets" });
    expect(adminMenuItems).toContainEqual({ label: "eBay Statements", href: "/finance/ebay-statements" });
    const invoices = hrefs.indexOf("/invoices");
    expect(hrefs.slice(invoices + 1, invoices + 4)).toEqual(["/invoice-cost-sets", "/purchases", "/suppliers"]);
  });

  it("includes the Pending Publish entry at the existing /ready-to-publish route (Sprint 139: relabeled from Ready to Publish - route unchanged)", () => {
    expect(adminMenuItems).toContainEqual({ label: "Pending Publish", href: "/ready-to-publish" });
  });
});
