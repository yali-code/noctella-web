// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as bridge from "@/lib/erpWarehouseBridge";
import ReservationDetailPage from "./page";

afterEach(() => vi.restoreAllMocks());

const activeReservation = { id: "r1", product_id: "p1", order_id: "o1", quantity: 2, status: "Active", expires_at: null };

async function renderPage(reservation: any) {
  vi.spyOn(bridge.erpWarehouseApi, "reservations").mockResolvedValue({ items: [reservation] });
  render(<ReservationDetailPage params={{ id: reservation.id }} />);
  await screen.findByRole("heading", { name: `Reservation ${reservation.id}` });
}

describe("Reservation detail lifecycle actions (Sprint 58B)", () => {
  it("renders real reservation data", async () => {
    await renderPage(activeReservation);
    expect(screen.getByText(/Product p1/)).toBeInTheDocument();
    expect(screen.getByText(/Quantity 2/)).toBeInTheDocument();
  });

  it("shows Release, Cancel and Consume for an Active reservation", async () => {
    await renderPage(activeReservation);
    expect(screen.getByText("Release")).toBeInTheDocument();
    expect(screen.getByText("Cancel Reservation")).toBeInTheDocument();
    expect(screen.getByText("Consume")).toBeInTheDocument();
  });

  it("hides Release, Cancel and Consume for a Released reservation", async () => {
    await renderPage({ ...activeReservation, status: "Released" });
    expect(screen.queryByText("Release")).not.toBeInTheDocument();
    expect(screen.queryByText("Cancel Reservation")).not.toBeInTheDocument();
    expect(screen.queryByText("Consume")).not.toBeInTheDocument();
  });

  it("requires confirmation for Release and reloads authoritative state after success", async () => {
    const user = userEvent.setup();
    await renderPage(activeReservation);
    const releaseSpy = vi.spyOn(bridge, "releaseReservation").mockResolvedValue({});
    vi.spyOn(bridge.erpWarehouseApi, "reservations").mockResolvedValueOnce({ items: [{ ...activeReservation, status: "Released" }] });
    await user.click(screen.getByText("Release"));
    expect(releaseSpy).not.toHaveBeenCalled();
    await user.click(screen.getByText("Confirm Release"));
    await waitFor(() => expect(screen.queryByText("Release")).not.toBeInTheDocument());
    expect(releaseSpy).toHaveBeenCalledWith("r1");
  });

  it("shows the backend's rejection message on failure", async () => {
    const user = userEvent.setup();
    await renderPage(activeReservation);
    vi.spyOn(bridge, "consumeReservation").mockRejectedValue(new Error("Reservation cannot be consumed"));
    await user.click(screen.getByText("Consume"));
    await user.click(screen.getByText("Confirm Consume"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Reservation cannot be consumed");
  });
});
