// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as bridge from "@/lib/erpWarehouseBridge";
import PackingDetailPage from "./page";

afterEach(() => vi.restoreAllMocks());

const baseTask = (overrides: any = {}) => ({
  id: "p1",
  order_id: "o1",
  picking_task_id: "t1",
  status: "Pending",
  package_count: 1,
  total_weight: null,
  lines: [{ id: "pl1", product_id: "prod-1", quantity: 2 }],
  ...overrides,
});

async function renderPage(task: any) {
  vi.spyOn(bridge.erpWarehouseApi, "packingTask").mockResolvedValue(task);
  render(<PackingDetailPage params={{ id: task.id }} />);
  await screen.findByRole("heading", { name: `Packing Task ${task.id}` });
}

describe("Packing detail lifecycle actions (Sprint 59B)", () => {
  it("renders real task data and a link to the linked picking task", async () => {
    await renderPage(baseTask());
    expect(screen.getByText(/Order o1/)).toBeInTheDocument();
    const link = screen.getByText("t1");
    expect(link.closest("a")).toHaveAttribute("href", "/picking/t1");
  });

  it("renders line quantities as plain read-only text - no input exists until Update Package Data is armed, and even then only for package-level fields", async () => {
    const user = userEvent.setup();
    await renderPage(baseTask());
    expect(screen.getByText("prod-1")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.queryAllByRole("spinbutton")).toHaveLength(0);
    await user.click(screen.getByText("Update Package Data"));
    expect(screen.queryAllByRole("spinbutton")).toHaveLength(2); // package count + weight only, no line-quantity input
  });

  it("shows Start for a Pending task", async () => {
    await renderPage(baseTask({ status: "Pending" }));
    expect(screen.getByText("Start")).toBeInTheDocument();
  });

  it("hides Start once InProgress", async () => {
    await renderPage(baseTask({ status: "InProgress" }));
    expect(screen.queryByText("Start")).not.toBeInTheDocument();
  });

  it("updates package count/weight and reloads authoritative state after success", async () => {
    const user = userEvent.setup();
    await renderPage(baseTask({ status: "InProgress" }));
    const updateSpy = vi.spyOn(bridge, "updatePackingTask").mockResolvedValue({});
    vi.spyOn(bridge.erpWarehouseApi, "packingTask").mockResolvedValueOnce(baseTask({ status: "InProgress", package_count: 3 }));
    await user.click(screen.getByText("Update Package Data"));
    const countInput = screen.getByPlaceholderText("Package count");
    await user.clear(countInput);
    await user.type(countInput, "3");
    await user.click(screen.getByText("Confirm Update Package Data"));
    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith("p1", expect.any(String), { packageCount: 3, totalWeight: undefined }));
  });

  it("shows Complete for InProgress but not Mark Ready", async () => {
    await renderPage(baseTask({ status: "InProgress" }));
    expect(screen.getByText("Complete")).toBeInTheDocument();
    expect(screen.queryByText("Mark Ready")).not.toBeInTheDocument();
  });

  it("shows Mark Ready for Packed but not Complete", async () => {
    await renderPage(baseTask({ status: "Packed" }));
    expect(screen.queryByText("Complete")).not.toBeInTheDocument();
    expect(screen.getByText("Mark Ready")).toBeInTheDocument();
  });

  it("shows the backend's rejection message on failure", async () => {
    const user = userEvent.setup();
    await renderPage(baseTask({ status: "Pending" }));
    vi.spyOn(bridge, "cancelPackingTask").mockRejectedValue(new Error("Packing task not found"));
    await user.click(screen.getByText("Cancel Task"));
    await user.click(screen.getByText("Confirm Cancel Task"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Packing task not found");
  });
});
