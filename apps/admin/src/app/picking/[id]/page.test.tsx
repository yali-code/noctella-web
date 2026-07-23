// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as bridge from "@/lib/erpWarehouseBridge";
import PickingDetailPage from "./page";

afterEach(() => vi.restoreAllMocks());

const baseTask = (overrides: any = {}) => ({
  id: "t1",
  order_id: "o1",
  status: "InProgress",
  safe_notes: null,
  lines: [{ id: "l1", product_id: "p1", requested_quantity: 3, picked_quantity: 0, short_quantity: 0 }],
  ...overrides,
});

async function renderPage(task: any) {
  vi.spyOn(bridge.erpWarehouseApi, "pickingTask").mockResolvedValue(task);
  render(<PickingDetailPage params={{ id: task.id }} />);
  await screen.findByRole("heading", { name: `Picking Task ${task.id}` });
}

describe("Picking detail lifecycle actions (Sprint 59B)", () => {
  it("renders real task and line data", async () => {
    await renderPage(baseTask());
    expect(screen.getByText(/Order o1/)).toBeInTheDocument();
    expect(screen.getByText("p1")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("shows Start only for a Pending task", async () => {
    await renderPage(baseTask({ status: "Pending" }));
    expect(screen.getByText("Start")).toBeInTheDocument();
  });

  it("hides Start for an InProgress task and shows per-line actions instead", async () => {
    await renderPage(baseTask({ status: "InProgress" }));
    expect(screen.queryByText("Start")).not.toBeInTheDocument();
    expect(screen.getByText("Confirm picked")).toBeInTheDocument();
    expect(screen.getByText("Mark short")).toBeInTheDocument();
  });

  it("confirms a picked quantity within the requested cap", async () => {
    const user = userEvent.setup();
    await renderPage(baseTask());
    const confirmSpy = vi.spyOn(bridge, "confirmPickedLine").mockResolvedValue({});
    await user.click(screen.getByText("Confirm picked"));
    const qtyInput = screen.getByRole("spinbutton") as HTMLInputElement;
    expect(qtyInput.max).toBe("3");
    await user.clear(qtyInput);
    await user.type(qtyInput, "2");
    await user.click(screen.getByText("Confirm Picked"));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledWith("t1", "l1", expect.any(String), 2));
  });

  it("rejects a picked quantity above the requested amount client-side, without calling the backend", async () => {
    const user = userEvent.setup();
    await renderPage(baseTask());
    const confirmSpy = vi.spyOn(bridge, "confirmPickedLine");
    await user.click(screen.getByText("Confirm picked"));
    const qtyInput = screen.getByRole("spinbutton");
    await user.clear(qtyInput);
    await user.type(qtyInput, "99");
    await user.click(screen.getByText("Confirm Picked"));
    await screen.findByText(/cannot exceed the requested quantity/);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("shows Complete and Cancel for an InProgress task, and reloads authoritative state after Complete", async () => {
    const user = userEvent.setup();
    await renderPage(baseTask({ status: "InProgress" }));
    const completeSpy = vi.spyOn(bridge, "completePickingTask").mockResolvedValue({});
    vi.spyOn(bridge.erpWarehouseApi, "pickingTask").mockResolvedValueOnce(baseTask({ status: "Picked" }));
    await user.click(screen.getByText("Complete"));
    await user.click(screen.getByText("Confirm Complete"));
    await screen.findByText(/Status Picked/);
    expect(completeSpy).toHaveBeenCalledWith("t1", expect.any(String));
  });

  it("shows the backend's rejection message on failure", async () => {
    const user = userEvent.setup();
    await renderPage(baseTask());
    vi.spyOn(bridge, "cancelPickingTask").mockRejectedValue(new Error("Picking task not found"));
    await user.click(screen.getByText("Cancel Task"));
    await user.click(screen.getByText("Confirm Cancel Task"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Picking task not found");
  });
});
