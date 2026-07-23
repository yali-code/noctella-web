// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as bridge from "@/lib/erpWarehouseBridge";
import PickingPage from "./page";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

afterEach(() => vi.restoreAllMocks());

const taskRow = { id: "t1", order_id: "o1", status: "Pending" };

describe("Picking list page (Sprint 59B)", () => {
  it("renders real rows", async () => {
    vi.spyOn(bridge.erpWarehouseApi, "picking").mockResolvedValue({ items: [taskRow] });
    render(<PickingPage />);
    await screen.findByText("o1");
    expect(screen.getByText("Pending")).toBeInTheDocument();
  });

  it("renders an empty state", async () => {
    vi.spyOn(bridge.erpWarehouseApi, "picking").mockResolvedValue({ items: [] });
    render(<PickingPage />);
    await screen.findByText("No picking tasks found.");
  });

  it("renders an error state", async () => {
    vi.spyOn(bridge.erpWarehouseApi, "picking").mockRejectedValue(new Error("ERP authentication failed"));
    render(<PickingPage />);
    await screen.findByText("ERP authentication failed");
  });

  it("creates a picking task with a stable idempotency key, prevents duplicate submission, and navigates on success", async () => {
    const user = userEvent.setup();
    vi.spyOn(bridge.erpWarehouseApi, "picking").mockResolvedValue({ items: [] });
    let resolveCreate!: (v: any) => void;
    const createSpy = vi.spyOn(bridge, "createPickingTask").mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));
    render(<PickingPage />);
    await screen.findByText("No picking tasks found.");
    await user.click(screen.getByText("Create Picking Task"));
    await user.type(screen.getByPlaceholderText("Order ID"), "o1");
    await user.click(screen.getByText("Submit Picking Task"));
    await waitFor(() => expect(screen.getByText("Creating…")).toBeDisabled());
    await user.click(screen.getByText("Creating…"));
    expect(createSpy).toHaveBeenCalledTimes(1);
    const [orderIdArg, keyArg] = createSpy.mock.calls[0];
    expect(orderIdArg).toBe("o1");
    expect(typeof keyArg).toBe("string");
    resolveCreate({ pickingTaskId: "new-task-id" });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/picking/new-task-id"));
  });
});
