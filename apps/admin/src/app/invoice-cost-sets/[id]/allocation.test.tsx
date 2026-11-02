// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as lib from "@/lib/invoiceIntakes";
import InvoiceCostSetDetailPage from "./page";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
afterEach(() => vi.restoreAllMocks());

/** PHASE-2C: bank debit + official rate, product picker with weights, preview table and approve on the cost set page. */
const setRow = { id: "cs1", status: "open", title: "Växjö 227552", purchaseId: null, approvedBy: null, approvedAt: null, notes: null, createdAt: "2026-11-02T10:00:00.000Z", updatedAt: "2026-11-02T10:00:00.000Z" } as const;
const reviewedIntake = (over: Record<string, unknown> = {}) => ({
  id: "in1", costSetId: "cs1", invoiceType: "auction", status: "reviewed", fileSha256: "a".repeat(64), fileSizeBytes: 2048, fileMime: "application/pdf", originalFilenameSanitized: "227552.pdf",
  createdAt: "2026-11-02T10:05:00.000Z", updatedAt: "2026-11-02T10:05:00.000Z", review: null,
  invoiceNumber: "227552", currency: "SEK", paidDate: "2026-09-18", totalOriginal: 1198, fxRate: null, fxRateDate: null, fxSource: null, bankDebitEur: null, fx: null, ...over,
});
const item = (n: number, over: Record<string, unknown> = {}) => ({
  productId: `p${n}`, sku: `CAM-${n}`, title: `Camera ${n}`, aiSuggestedPriceEur: n * 10, purchaseCost: null, valueWeightEur: n * 10, weightSource: "ai",
  allocLotEur: null, allocHammerFeeEur: null, allocPremiumEur: null, allocTransportEur: null, allocForwarderEur: null, allocFxDiffEur: null, allocTotalEur: null, ...over,
});
const preview = (over: Partial<lib.CostSetPreview> = {}): lib.CostSetPreview => ({
  issues: [], warnings: [],
  intakes: [{ intakeId: "in1", invoiceType: "auction", invoiceNumber: "227552", currency: "SEK", totalOriginal: 1198, fxRate: 11.0625, fxRateDate: "2026-09-18", fxSource: "ECB", officialEur: 108.29, bankDebitEur: 109.65, fxDiffEur: 1.36 }],
  items: [
    { productId: "p1", sku: "CAM-1", title: "Camera 1", lotEur: 28.53, hammerFeeEur: 1.93, premiumEur: 5.71, transportEur: 0, forwarderEur: 0, fxDiffEur: 0.45, totalEur: 36.62 },
    { productId: "p2", sku: "CAM-2", title: "Camera 2", lotEur: 57.07, hammerFeeEur: 3.86, premiumEur: 11.42, transportEur: 0, forwarderEur: 0, fxDiffEur: 0.91, totalEur: 73.26 },
  ].map((i) => ({ ...i, totalEur: i.totalEur })),
  totalBankDebitEur: 109.65, totalAllocatedEur: 109.65, ...over,
});
// Make the two rows add up exactly to the bank debit.
const okPreview = () => { const p = preview(); p.items[1].totalEur = 73.03; p.items[1].fxDiffEur = 0.68; return p; };

describe("Invoice cost set page — allocation and approve (PHASE-2C)", () => {
  it("saves the bank debit and shows the official rate, rate date, official EUR and FX difference", async () => {
    const user = userEvent.setup();
    const get = vi.spyOn(lib.invoiceIntakeApi, "getCostSet")
      .mockResolvedValueOnce({ ...setRow, intakes: [reviewedIntake()], items: [] } as any)
      .mockResolvedValue({ ...setRow, intakes: [reviewedIntake({ fxRate: 11.0625, fxRateDate: "2026-09-18", fxSource: "ECB", bankDebitEur: 109.65, fx: { officialEur: 108.29, fxDiffEur: 1.36 }, updatedAt: "x" })], items: [] } as any);
    const save = vi.spyOn(lib.invoiceIntakeApi, "setBankDebit").mockResolvedValue({} as any);
    render(<InvoiceCostSetDetailPage params={{ id: "cs1" }} />);
    const group = await screen.findByRole("group", { name: "Bank debit 227552" });
    await user.type(within(group).getByLabelText("Bank debit (EUR)"), "109.65");
    await user.click(within(group).getByRole("button", { name: "Save & get official rate" }));
    expect(save).toHaveBeenCalledWith("in1", 109.65);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/ECB rate 11.0625 \(2026-09-18\) · official 108.29 EUR · bank 109.65 EUR · FX difference 1.36 EUR/)).toBeInTheDocument();
  });

  it("shows a generic rate error", async () => {
    const user = userEvent.setup();
    vi.spyOn(lib.invoiceIntakeApi, "getCostSet").mockResolvedValue({ ...setRow, intakes: [reviewedIntake()], items: [] } as any);
    vi.spyOn(lib.invoiceIntakeApi, "setBankDebit").mockRejectedValue(new Error("The official exchange rate is not available right now. Try again later."));
    render(<InvoiceCostSetDetailPage params={{ id: "cs1" }} />);
    const group = await screen.findByRole("group", { name: "Bank debit 227552" });
    await user.type(within(group).getByLabelText("Bank debit (EUR)"), "10");
    await user.click(within(group).getByRole("button", { name: "Save & get official rate" }));
    expect(await within(group).findByRole("alert")).toHaveTextContent("not available right now");
  });

  it("searches candidates, adds one, edits a weight (source becomes admin) and saves the selection", async () => {
    const user = userEvent.setup();
    vi.spyOn(lib.invoiceIntakeApi, "getCostSet").mockResolvedValue({ ...setRow, intakes: [reviewedIntake()], items: [item(1)] } as any);
    const search = vi.spyOn(lib.invoiceIntakeApi, "productCandidates").mockResolvedValue({ items: [
      { productId: "p1", sku: "CAM-1", title: "Camera 1", createdAt: "2026-10-01T00:00:00.000Z", purchaseCost: null, aiSuggestedPriceEur: 10 },
      { productId: "p2", sku: "CAM-2", title: "Camera 2", createdAt: "2026-10-02T00:00:00.000Z", purchaseCost: null, aiSuggestedPriceEur: 20 },
    ] });
    const save = vi.spyOn(lib.invoiceIntakeApi, "setProducts").mockResolvedValue({ items: [item(1, { valueWeightEur: 15, weightSource: "admin" }), item(2)] } as any);
    render(<InvoiceCostSetDetailPage params={{ id: "cs1" }} />);
    await screen.findByText("CAM-1");
    await user.type(screen.getByPlaceholderText("SKU or title"), "cam");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(search).toHaveBeenCalledWith("cs1", "cam");
    const table = await screen.findByRole("table", { name: "Product candidates" });
    expect(within(table).getByRole("button", { name: "Added" })).toBeDisabled();
    await user.click(within(table).getByRole("button", { name: "Add" }));

    const weight = screen.getByLabelText("Weight CAM-1");
    await user.clear(weight);
    await user.type(weight, "15");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview allocation" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Save products" }));
    expect(save).toHaveBeenCalledWith("cs1", [{ productId: "p1", valueWeightEur: 15 }, { productId: "p2" }]);
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument());
    expect(screen.getAllByText("admin").length).toBeGreaterThan(0);
  });

  it("PHASE-2C-1: shows the fallback (average) badge with the pre-filled weight and the note; editing it makes it admin", async () => {
    const user = userEvent.setup();
    vi.spyOn(lib.invoiceIntakeApi, "getCostSet").mockResolvedValue({ ...setRow, intakes: [reviewedIntake()], items: [item(5), item(9, { aiSuggestedPriceEur: null, valueWeightEur: 45, weightSource: "fallback" })] } as any);
    const save = vi.spyOn(lib.invoiceIntakeApi, "setProducts").mockResolvedValue({ items: [item(5), item(9, { aiSuggestedPriceEur: null, valueWeightEur: 40, weightSource: "admin" })] } as any);
    render(<InvoiceCostSetDetailPage params={{ id: "cs1" }} />);
    const row = (await screen.findByText("CAM-9")).closest("tr")!;
    expect(within(row).getByText("fallback (average)")).toBeInTheDocument();
    expect(within(row).getByLabelText("Weight CAM-9")).toHaveValue(45);
    expect(screen.getByText("Items without an AI estimate use the average of the AI estimates in this set; edit any value to override.")).toBeInTheDocument();

    const weight = within(row).getByLabelText("Weight CAM-9");
    await user.clear(weight);
    await user.type(weight, "40");
    expect(within(row).getByText("admin")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save products" }));
    expect(save).toHaveBeenCalledWith("cs1", [{ productId: "p5" }, { productId: "p9", valueWeightEur: 40 }]);
  });

  it("shows the preview table with a totals row equal to the bank debits; issues block approve (red), warnings show (amber)", async () => {
    const user = userEvent.setup();
    vi.spyOn(lib.invoiceIntakeApi, "getCostSet").mockResolvedValue({ ...setRow, intakes: [reviewedIntake()], items: [item(1), item(2)] } as any);
    const run = vi.spyOn(lib.invoiceIntakeApi, "preview")
      .mockResolvedValueOnce(preview({ issues: [{ code: "MISSING_RATE", message: "Invoice 227552 has no official exchange rate" }], items: [], intakes: [], totalBankDebitEur: 0, totalAllocatedEur: 0 }))
      .mockResolvedValueOnce({ ...okPreview(), warnings: [{ code: "ITEM_COUNT_MISMATCH", message: "Lot 5332164 says 8 item(s), 2 product(s) selected" }] });
    render(<InvoiceCostSetDetailPage params={{ id: "cs1" }} />);
    const approve = await screen.findByRole("button", { name: "Approve & create purchase" });
    expect(approve).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Preview allocation" }));
    expect(await screen.findByTestId("allocation-issue")).toHaveTextContent("no official exchange rate");
    expect(screen.getByRole("button", { name: "Approve & create purchase" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Preview allocation" }));
    expect(run).toHaveBeenCalledTimes(2);
    expect(await screen.findByTestId("allocation-warning")).toHaveTextContent("2 product(s) selected");
    const totals = screen.getByTestId("allocation-totals");
    expect(totals).toHaveTextContent("bank debits 109.65");
    expect(within(totals).getAllByRole("cell").at(-1)).toHaveTextContent("109.65");
    expect(screen.getByRole("button", { name: "Approve & create purchase" })).toBeEnabled();
  });

  it("approves through an inline confirm step (no window.confirm) and links to the Draft purchase", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm");
    vi.spyOn(lib.invoiceIntakeApi, "getCostSet").mockResolvedValue({ ...setRow, intakes: [reviewedIntake()], items: [item(1), item(2)] } as any);
    vi.spyOn(lib.invoiceIntakeApi, "preview").mockResolvedValue(okPreview());
    const approve = vi.spyOn(lib.invoiceIntakeApi, "approve").mockResolvedValue({ ...setRow, status: "approved", purchaseId: "pur-1" } as any);
    render(<InvoiceCostSetDetailPage params={{ id: "cs1" }} />);
    await user.click(await screen.findByRole("button", { name: "Preview allocation" }));
    await user.click(await screen.findByRole("button", { name: "Approve & create purchase" }));
    const confirm = screen.getByRole("group", { name: "Confirm approve" });
    expect(confirm).toHaveTextContent("Create a Draft purchase with 2 line(s) totalling 109.65 EUR?");
    await user.click(within(confirm).getByRole("button", { name: "Back" }));
    expect(approve).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Approve & create purchase" }));
    await user.click(screen.getByRole("button", { name: "Confirm approve" }));
    expect(approve).toHaveBeenCalledWith("cs1");
    expect(await screen.findByRole("link", { name: "/purchases/pur-1" })).toHaveAttribute("href", "/purchases/pur-1");
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("an approved set is read-only and shows its stored allocation and the purchase link", async () => {
    vi.spyOn(lib.invoiceIntakeApi, "getCostSet").mockResolvedValue({
      ...setRow, status: "approved", purchaseId: "pur-9",
      intakes: [reviewedIntake({ fxRate: 11.0625, fxRateDate: "2026-09-18", fxSource: "ECB", bankDebitEur: 109.65, fx: { officialEur: 108.29, fxDiffEur: 1.36 } })],
      items: [item(1, { allocLotEur: 50, allocHammerFeeEur: 3, allocPremiumEur: 10, allocTransportEur: 0, allocForwarderEur: 0, allocFxDiffEur: 1, allocTotalEur: 64 })],
    } as any);
    render(<InvoiceCostSetDetailPage params={{ id: "cs1" }} />);
    expect(await screen.findByRole("link", { name: "/purchases/pur-9" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save & get official rate" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Preview allocation" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve & create purchase" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel set" })).not.toBeInTheDocument();
    expect(within(screen.getByTestId("allocation-totals")).getAllByRole("cell").at(-1)).toHaveTextContent("64.00");
  });
});
