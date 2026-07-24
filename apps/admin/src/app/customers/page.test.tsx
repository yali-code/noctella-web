// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import * as bridge from "@/lib/erpCustomerBridge";
import CustomersPage from "./page";

afterEach(() => vi.restoreAllMocks());

describe("Customers list page (Sprint 61B - proxy recovery)", () => {
  it("renders real rows through the customer bridge", async () => {
    vi.spyOn(bridge.customerApi, "list").mockResolvedValue({ items: [{ id: "c1", name: "Ada", email: "a***@x.test", erpReferenceId: "ERP-1" }] });
    render(await CustomersPage());
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("ERP-1")).toBeInTheDocument();
    expect(screen.getByText("Customer Merge")).toBeInTheDocument();
  });

  it("renders an empty state without a raw crash", async () => {
    vi.spyOn(bridge.customerApi, "list").mockResolvedValue({ items: [] });
    render(await CustomersPage());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Customers")).toBeInTheDocument();
  });

  it("renders a graceful error state instead of throwing when the proxy call fails", async () => {
    vi.spyOn(bridge.customerApi, "list").mockRejectedValue(new Error("ERP authentication failed"));
    render(await CustomersPage());
    expect(await screen.findByRole("alert")).toHaveTextContent("ERP authentication failed");
  });
});
