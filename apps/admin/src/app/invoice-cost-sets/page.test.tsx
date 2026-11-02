// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as lib from "@/lib/invoiceIntakes";
import InvoiceCostSetsPage from "./page";
import InvoiceCostSetDetailPage from "./[id]/page";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

afterEach(() => vi.restoreAllMocks());

const setRow = { id: "cs1", status: "open", title: "Växjö 227552 – lot 5332164", purchaseId: null, approvedBy: null, approvedAt: null, notes: null, createdAt: "2026-11-02T10:00:00.000Z", updatedAt: "2026-11-02T10:00:00.000Z" } as const;
const intakeRow = { id: "in1", costSetId: "cs1", invoiceType: "auction", status: "uploaded", fileSha256: "a".repeat(64), fileSizeBytes: 2048, fileMime: "application/pdf", originalFilenameSanitized: "invoice.pdf", createdAt: "2026-11-02T10:05:00.000Z", updatedAt: "2026-11-02T10:05:00.000Z" } as const;

describe("Invoice cost sets list page (PHASE-2A)", () => {
  it("renders cost set rows with a link to the detail page", async () => {
    vi.spyOn(lib.invoiceIntakeApi, "listCostSets").mockResolvedValue({ items: [setRow as any], total: 1, page: 1, pageSize: 100 });
    render(<InvoiceCostSetsPage />);
    await screen.findByText(setRow.title);
    expect(screen.getByRole("link", { name: "View" })).toHaveAttribute("href", "/invoice-cost-sets/cs1");
  });

  it("renders an empty state and an error state", async () => {
    vi.spyOn(lib.invoiceIntakeApi, "listCostSets").mockResolvedValueOnce({ items: [], total: 0, page: 1, pageSize: 100 });
    const { unmount } = render(<InvoiceCostSetsPage />);
    await screen.findByText("No cost sets yet.");
    unmount();
    vi.spyOn(lib.invoiceIntakeApi, "listCostSets").mockRejectedValueOnce(new Error("ERP authentication failed"));
    render(<InvoiceCostSetsPage />);
    await screen.findByText("ERP authentication failed");
  });

  it("creates a new cost set and navigates to it", async () => {
    const user = userEvent.setup();
    vi.spyOn(lib.invoiceIntakeApi, "listCostSets").mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 });
    const create = vi.spyOn(lib.invoiceIntakeApi, "createCostSet").mockResolvedValue({ ...setRow, id: "cs2" } as any);
    render(<InvoiceCostSetsPage />);
    await screen.findByText("No cost sets yet.");
    await user.click(screen.getByText("New cost set"));
    await user.type(screen.getByPlaceholderText("Title"), "Lot 9");
    await user.click(screen.getByText("Create cost set"));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/invoice-cost-sets/cs2"));
    expect(create).toHaveBeenCalledWith({ title: "Lot 9", notes: null });
  });
});

describe("Invoice cost set detail page (PHASE-2A)", () => {
  it("renders intakes with View file and uploads a file with the chosen type", async () => {
    const user = userEvent.setup();
    const get = vi.spyOn(lib.invoiceIntakeApi, "getCostSet").mockResolvedValue({ ...setRow, intakes: [intakeRow] } as any);
    const upload = vi.spyOn(lib.invoiceIntakeApi, "uploadFile").mockResolvedValue(intakeRow as any);
    render(<InvoiceCostSetDetailPage params={{ id: "cs1" }} />);
    await screen.findByText("invoice.pdf");
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View file" })).toHaveAttribute("href", "/api/erp/invoice-intakes/in1/file");

    await user.selectOptions(screen.getByLabelText(/Invoice type/), "transport");
    const file = new File(["%PDF-1.4"], "transport.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText(/Invoice file/), file);
    await user.click(screen.getByText("Upload"));
    await waitFor(() => expect(upload).toHaveBeenCalledWith("cs1", "transport", file));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });

  it("cancels an intake and the set, and shows backend errors", async () => {
    const user = userEvent.setup();
    vi.spyOn(lib.invoiceIntakeApi, "getCostSet").mockResolvedValue({ ...setRow, intakes: [intakeRow] } as any);
    const cancelIntake = vi.spyOn(lib.invoiceIntakeApi, "cancelIntake").mockResolvedValue({ ...intakeRow, status: "cancelled" } as any);
    const cancelSet = vi.spyOn(lib.invoiceIntakeApi, "cancelCostSet").mockRejectedValue(new Error("Only an open invoice cost set can be cancelled"));
    render(<InvoiceCostSetDetailPage params={{ id: "cs1" }} />);
    await screen.findByText("invoice.pdf");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(cancelIntake).toHaveBeenCalledWith("in1"));
    await user.click(screen.getByRole("button", { name: "Cancel set" }));
    await screen.findByText("Only an open invoice cost set can be cancelled");
    expect(cancelSet).toHaveBeenCalledWith("cs1");
  });

  it("hides upload and cancel controls for a cancelled set", async () => {
    vi.spyOn(lib.invoiceIntakeApi, "getCostSet").mockResolvedValue({ ...setRow, status: "cancelled", intakes: [intakeRow] } as any);
    render(<InvoiceCostSetDetailPage params={{ id: "cs1" }} />);
    await screen.findByText("invoice.pdf");
    expect(screen.queryByText("Upload invoice")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel set" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });
});
