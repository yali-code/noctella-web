// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as bridge from "@/lib/erpWarehouseBridge";
import PackingPage from "./page";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

afterEach(() => vi.restoreAllMocks());

const taskRow = { id: "p1", order_id: "o1", status: "Pending", package_count: 1 };

describe("Packing list page (Sprint 59B)", () => {
  it("renders real rows", async () => {
    vi.spyOn(bridge.erpWarehouseApi, "packing").mockResolvedValue({ items: [taskRow] });
    render(<PackingPage />);
    await screen.findByText("o1");
    expect(screen.getByText("Pending")).toBeInTheDocument();
  });

  it("renders an empty state", async () => {
    vi.spyOn(bridge.erpWarehouseApi, "packing").mockResolvedValue({ items: [] });
    render(<PackingPage />);
    await screen.findByText("No packing tasks found.");
  });

  it("creates a packing task from a completed picking task, prevents duplicate submission, and navigates on success", async () => {
    const user = userEvent.setup();
    vi.spyOn(bridge.erpWarehouseApi, "packing").mockResolvedValue({ items: [] });
    let resolveCreate!: (v: any) => void;
    const createSpy = vi.spyOn(bridge, "createPackingTask").mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));
    render(<PackingPage />);
    await screen.findByText("No packing tasks found.");
    await user.click(screen.getByText("Create Packing Task"));
    await user.type(screen.getByPlaceholderText("Order ID"), "o1");
    await user.type(screen.getByPlaceholderText("Completed picking task ID"), "t1");
    await user.click(screen.getByText("Submit Packing Task"));
    await waitFor(() => expect(screen.getByText("Creating…")).toBeDisabled());
    await user.click(screen.getByText("Creating…"));
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith("o1", expect.any(String), { pickingTaskId: "t1" });
    resolveCreate({ packingTaskId: "new-packing-id" });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/packing/new-packing-id"));
  });
});
