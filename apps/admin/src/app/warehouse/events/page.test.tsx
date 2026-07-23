// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import * as bridge from "@/lib/erpWarehouseBridge";
import WarehouseEventsPage from "./page";

afterEach(() => vi.restoreAllMocks());

describe("Warehouse events page (Sprint 58B, read-only)", () => {
  it("renders real event rows", async () => {
    vi.spyOn(bridge.erpWarehouseApi, "events").mockResolvedValue({ items: [{ id: "e1", event_type: "ReservationCreated", product_id: "p1", created_at: "2026-01-01T00:00:00.000Z" }] });
    render(<WarehouseEventsPage />);
    await screen.findByText("ReservationCreated");
    expect(screen.getByText("p1")).toBeInTheDocument();
  });

  it("renders an empty state", async () => {
    vi.spyOn(bridge.erpWarehouseApi, "events").mockResolvedValue({ items: [] });
    render(<WarehouseEventsPage />);
    await screen.findByText("No warehouse events found.");
  });

  it("renders an error state", async () => {
    vi.spyOn(bridge.erpWarehouseApi, "events").mockRejectedValue(new Error("ERP authentication failed"));
    render(<WarehouseEventsPage />);
    await screen.findByText("ERP authentication failed");
  });
});
