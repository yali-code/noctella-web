// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as returnsLib from "@/lib/returns";
import ReturnDetail from "./page";

afterEach(() => vi.restoreAllMocks());

const baseReturn = (overrides: Partial<returnsLib.ReturnRow> = {}): returnsLib.ReturnRow => ({
  id: "ret1",
  orderId: "ord1",
  status: "requested",
  reason: "damaged",
  requestedResolution: "refund",
  requestedAt: "2026-01-01T00:00:00.000Z",
  items: [{ id: "it1", orderItemId: "oi1", quantityRequested: 3 }],
  ...overrides,
});

function mockLoad(row: returnsLib.ReturnRow) {
  vi.spyOn(returnsLib, "getReturn").mockResolvedValue(row);
  vi.spyOn(returnsLib, "getReturnEvents").mockResolvedValue([]);
  vi.spyOn(returnsLib, "getReturnReadiness").mockResolvedValue({ ready: true, reasons: [], allowedActions: [] });
}

async function renderPage(row: returnsLib.ReturnRow) {
  mockLoad(row);
  render(<ReturnDetail params={{ id: row.id }} />);
  await screen.findByText(`Return ${row.id}`);
}

describe("Return detail lifecycle actions (Sprint 56B)", () => {
  it("shows only backend-eligible actions for a Requested return", async () => {
    await renderPage(baseReturn({ status: "requested" }));
    expect(screen.getByText("Authorize")).toBeInTheDocument();
    expect(screen.getByText("Reject")).toBeInTheDocument();
    expect(screen.getByText("Cancel return")).toBeInTheDocument();
    expect(screen.queryByText("Receive")).not.toBeInTheDocument();
    expect(screen.queryByText("Inspect item")).not.toBeInTheDocument();
    expect(screen.queryByText("Approve")).not.toBeInTheDocument();
    expect(screen.queryByText("Complete")).not.toBeInTheDocument();
    expect(screen.queryByText("Mark in transit")).not.toBeInTheDocument();
  });

  it("requires a confirmation step before submitting an action", async () => {
    const user = userEvent.setup();
    const authorize = vi.spyOn(returnsLib, "authorizeReturn").mockResolvedValue(baseReturn({ status: "authorized" }));
    await renderPage(baseReturn({ status: "requested" }));
    await user.click(screen.getByText("Authorize"));
    expect(authorize).not.toHaveBeenCalled();
    await user.click(await screen.findByText("Confirm Authorize"));
    await waitFor(() => expect(authorize).toHaveBeenCalledWith("ret1"));
  });

  it("collects the required inspect fields (item, quantity, disposition) and does not allow a quantity above the requested amount", async () => {
    const user = userEvent.setup();
    const inspect = vi.spyOn(returnsLib, "inspectReturnItem").mockResolvedValue(baseReturn({ status: "inspecting" }));
    await renderPage(baseReturn({ status: "received" }));
    await user.click(screen.getByText("Inspect item"));
    const qtyInput = await screen.findByPlaceholderText("Qty received");
    await user.clear(qtyInput);
    await user.type(qtyInput, "2");
    const dispositionSelect = screen.getByDisplayValue("Disposition…");
    await user.selectOptions(dispositionSelect, "return_to_stock");
    await user.click(screen.getByText("Confirm Inspect item"));
    await waitFor(() => expect(inspect).toHaveBeenCalledWith("ret1", { orderItemId: "oi1", quantityReceived: 2, stockDisposition: "return_to_stock", condition: undefined }));

    // Over-cap quantity is rejected client-side and never reaches the backend.
    inspect.mockClear();
    await user.click(screen.getByText("Inspect item"));
    const qtyInput2 = await screen.findByPlaceholderText("Qty received");
    await user.clear(qtyInput2);
    await user.type(qtyInput2, "99");
    await user.click(screen.getByText("Confirm Inspect item"));
    await screen.findByText(/cannot exceed the requested quantity/);
    expect(inspect).not.toHaveBeenCalled();
  });

  it("disables the confirm button while submitting and prevents a duplicate submission", async () => {
    const user = userEvent.setup();
    let resolveAuthorize!: (v: returnsLib.ReturnRow) => void;
    const authorize = vi.spyOn(returnsLib, "authorizeReturn").mockReturnValue(new Promise((resolve) => { resolveAuthorize = resolve; }));
    await renderPage(baseReturn({ status: "requested" }));
    await user.click(screen.getByText("Authorize"));
    const confirmBtn = await screen.findByText("Confirm Authorize");
    await user.click(confirmBtn);
    await waitFor(() => expect(screen.getByText("Submitting…")).toBeDisabled());
    await user.click(screen.getByText("Submitting…"));
    expect(authorize).toHaveBeenCalledTimes(1);
    resolveAuthorize(baseReturn({ status: "authorized" }));
  });

  it("displays a backend validation error", async () => {
    const user = userEvent.setup();
    vi.spyOn(returnsLib, "authorizeReturn").mockRejectedValue(new Error("Invalid return status transition"));
    await renderPage(baseReturn({ status: "requested" }));
    await user.click(screen.getByText("Authorize"));
    await user.click(screen.getByText("Confirm Authorize"));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("Invalid return status transition");
  });

  it("displays a concurrency conflict distinctly from an ordinary validation error", async () => {
    const user = userEvent.setup();
    vi.spyOn(returnsLib, "authorizeReturn").mockRejectedValue(new Error("Return was updated by another transaction"));
    await renderPage(baseReturn({ status: "requested" }));
    await user.click(screen.getByText("Authorize"));
    await user.click(screen.getByText("Confirm Authorize"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Concurrency conflict/);
  });

  it("reloads authoritative backend state after a success rather than fabricating the new status", async () => {
    const user = userEvent.setup();
    const getReturnSpy = vi.spyOn(returnsLib, "getReturn")
      .mockResolvedValueOnce(baseReturn({ status: "requested" }))
      .mockResolvedValueOnce(baseReturn({ status: "authorized" }));
    vi.spyOn(returnsLib, "getReturnEvents").mockResolvedValue([]);
    vi.spyOn(returnsLib, "getReturnReadiness").mockResolvedValue({ ready: true, reasons: [], allowedActions: [] });
    vi.spyOn(returnsLib, "authorizeReturn").mockResolvedValue(baseReturn({ status: "authorized" }));
    render(<ReturnDetail params={{ id: "ret1" }} />);
    await screen.findByText(/Status requested/);
    await user.click(screen.getByText("Authorize"));
    await user.click(screen.getByText("Confirm Authorize"));
    await screen.findByText(/Status authorized/);
    expect(getReturnSpy).toHaveBeenCalledTimes(2);
  });

  it("does not expose a separate inventory-restoration action alongside Complete", async () => {
    await renderPage(baseReturn({ status: "approved" }));
    expect(screen.getByText("Complete")).toBeInTheDocument();
    expect(screen.queryByText(/restore inventory/i)).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByText("Complete"));
    expect(await screen.findByText(/restored automatically/)).toBeInTheDocument();
    expect(screen.queryByText(/^Restore inventory$/i)).not.toBeInTheDocument();
  });
});
