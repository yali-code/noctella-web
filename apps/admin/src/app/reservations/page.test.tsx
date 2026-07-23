// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as bridge from "@/lib/erpWarehouseBridge";
import ReservationsPage from "./page";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

afterEach(() => vi.restoreAllMocks());

const reservationRow = { id: "r1", product_id: "p1", order_id: null, quantity: 2, status: "Active", expires_at: null };

describe("Reservations list page (Sprint 58B)", () => {
  it("renders real rows", async () => {
    vi.spyOn(bridge.erpWarehouseApi, "reservations").mockResolvedValue({ items: [reservationRow] });
    render(<ReservationsPage />);
    await screen.findByText("p1");
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("renders an empty state", async () => {
    vi.spyOn(bridge.erpWarehouseApi, "reservations").mockResolvedValue({ items: [] });
    render(<ReservationsPage />);
    await screen.findByText("No reservations found.");
  });

  it("creates a reservation with a stable idempotency key, prevents duplicate submission, and navigates on success", async () => {
    const user = userEvent.setup();
    vi.spyOn(bridge.erpWarehouseApi, "reservations").mockResolvedValue({ items: [] });
    let resolveCreate!: (v: any) => void;
    const createSpy = vi.spyOn(bridge, "createReservation").mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));
    render(<ReservationsPage />);
    await screen.findByText("No reservations found.");
    await user.click(screen.getByText("Create Reservation"));
    await user.type(screen.getByPlaceholderText("Product ID"), "p1");
    await user.clear(screen.getByPlaceholderText("Quantity"));
    await user.type(screen.getByPlaceholderText("Quantity"), "2");
    await user.type(screen.getByPlaceholderText("Reservation reference"), "REF-1");
    await user.type(screen.getByPlaceholderText("Reason"), "hold for order");
    await user.click(screen.getByText("Submit Reservation"));
    await waitFor(() => expect(screen.getByText("Submitting…")).toBeDisabled());
    await user.click(screen.getByText("Submitting…"));
    expect(createSpy).toHaveBeenCalledTimes(1);
    const call = createSpy.mock.calls[0][0];
    expect(call.productId).toBe("p1");
    expect(call.quantity).toBe(2);
    expect(typeof call.idempotencyKey).toBe("string");
    resolveCreate({ reservationId: "new-reservation-id" });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/reservations/new-reservation-id"));
  });

  it("rejects an invalid quantity client-side without calling the backend", async () => {
    const user = userEvent.setup();
    vi.spyOn(bridge.erpWarehouseApi, "reservations").mockResolvedValue({ items: [] });
    const createSpy = vi.spyOn(bridge, "createReservation");
    render(<ReservationsPage />);
    await screen.findByText("No reservations found.");
    await user.click(screen.getByText("Create Reservation"));
    await user.type(screen.getByPlaceholderText("Product ID"), "p1");
    await user.clear(screen.getByPlaceholderText("Quantity"));
    await user.type(screen.getByPlaceholderText("Quantity"), "0");
    await user.type(screen.getByPlaceholderText("Reservation reference"), "REF-1");
    await user.type(screen.getByPlaceholderText("Reason"), "hold");
    await user.click(screen.getByText("Submit Reservation"));
    await screen.findByText(/positive whole number/);
    expect(createSpy).not.toHaveBeenCalled();
  });
});
