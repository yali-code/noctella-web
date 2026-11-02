// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as lib from "@/lib/invoiceIntakes";
import InvoiceCostSetDetailPage from "./page";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
afterEach(() => vi.restoreAllMocks());

/** PHASE-2B: "Read with AI" and the review panel on the cost set detail page. */
const setRow = { id: "cs1", status: "open", title: "Växjö 227552", purchaseId: null, approvedBy: null, approvedAt: null, notes: null, createdAt: "2026-11-02T10:00:00.000Z", updatedAt: "2026-11-02T10:00:00.000Z" } as const;
const base = { costSetId: "cs1", invoiceType: "auction", fileSha256: "a".repeat(64), fileSizeBytes: 2048, fileMime: "application/pdf", createdAt: "2026-11-02T10:05:00.000Z", updatedAt: "2026-11-02T10:05:00.000Z", review: null } as const;

const f = (value: any, evidence: string | null = value === null ? null : String(value), confidence = 0.95) => ({ value, evidence, confidence });
const extracted = {
  invoiceType: f("auction"), supplierName: f("Växjö Auktionskammare"), supplierVatNumber: f("SE556923023701"), platform: f("Auctionet", "Auctionet", 0.5),
  invoiceNumber: f("227552"), issueDate: f("2026-10-20"), dueDate: f(null), paidDate: f(null), currency: f("SEK"), vatNote: f(null), reverseCharge: f(true, "No VAT charged"),
  total: f(1198, "1,198 SEK"),
  lots: [{ lotNumber: f("5332164"), title: f("KAMEROR, 8 st"), itemCountHint: f(8, "8 st"), amount: f(945) }],
  fees: [{ type: f("hammer_fee"), label: f("Hammer fee"), amount: f(64), percent: f(null), lotNumber: f(null) }, { type: f("buyer_premium"), label: f("Buyer's premium (20.00% excl. VAT)"), amount: f(189), percent: f(20, "20.00%"), lotNumber: f(null) }],
};
const effective = {
  invoiceType: "auction", supplierName: "Växjö Auktionskammare", supplierVatNumber: "SE556923023701", platform: "Auctionet", invoiceNumber: "227552", issueDate: "2026-10-20", dueDate: null, paidDate: null, currency: "SEK", vatNote: null, reverseCharge: true, total: 1198,
  lots: [{ lotNumber: "5332164", title: "KAMEROR, 8 st", itemCountHint: 8, amount: 945 }],
  fees: [{ type: "hammer_fee", label: "Hammer fee", amount: 64, percent: null, lotNumber: null }, { type: "buyer_premium", label: "Buyer's premium (20.00% excl. VAT)", amount: 189, percent: 20, lotNumber: null }],
};
const okChecks = [{ code: "TOTAL_MISMATCH", ok: true, message: "Lots and fees add up to the total (1198.00)" }, { code: "CURRENCY_MISSING", ok: true, message: "Currency SEK" }];
const extractedIntake = (checks: any[] = okChecks) => ({ ...base, id: "in2", status: "extracted", originalFilenameSanitized: "227552.pdf", review: { extracted, effective, editedFields: [], checks, model: "m", extractedAt: "2026-11-02T10:06:00.000Z", editedAt: null } });

describe("Invoice cost set detail page — AI extraction and review (PHASE-2B)", () => {
  it("shows Read with AI for uploaded, Read again for extracted, nothing for reviewed/cancelled, with a loading state", async () => {
    const user = userEvent.setup();
    const intakes = [
      { ...base, id: "in1", status: "uploaded", originalFilenameSanitized: "a.pdf" },
      extractedIntake(),
      { ...base, id: "in3", status: "reviewed", originalFilenameSanitized: "c.pdf" },
      { ...base, id: "in4", status: "cancelled", originalFilenameSanitized: "d.pdf" },
    ];
    const get = vi.spyOn(lib.invoiceIntakeApi, "getCostSet").mockResolvedValue({ ...setRow, intakes } as any);
    let resolve!: (v: any) => void;
    const extract = vi.spyOn(lib.invoiceIntakeApi, "extractIntake").mockImplementation(() => new Promise((r) => { resolve = r; }));
    render(<InvoiceCostSetDetailPage params={{ id: "cs1" }} />);
    await screen.findByText("a.pdf");
    expect(screen.getAllByRole("button", { name: "Read with AI" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Read again" })).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Read with AI" }));
    expect(extract).toHaveBeenCalledWith("in1");
    expect(await screen.findByRole("button", { name: "Reading…" })).toBeDisabled();
    resolve({});
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });

  it("shows a generic extraction error", async () => {
    const user = userEvent.setup();
    vi.spyOn(lib.invoiceIntakeApi, "getCostSet").mockResolvedValue({ ...setRow, intakes: [{ ...base, id: "in1", status: "uploaded", originalFilenameSanitized: "a.pdf" }] } as any);
    vi.spyOn(lib.invoiceIntakeApi, "extractIntake").mockRejectedValue(new Error("AI invoice reading is not available. Enter the invoice values manually."));
    render(<InvoiceCostSetDetailPage params={{ id: "cs1" }} />);
    await user.click(await screen.findByRole("button", { name: "Read with AI" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("AI invoice reading is not available");
  });

  it("renders the review form with evidence, low-confidence highlight and checks; edits invoice type, lots and fees and confirms", async () => {
    const user = userEvent.setup();
    vi.spyOn(lib.invoiceIntakeApi, "getCostSet").mockResolvedValue({ ...setRow, intakes: [extractedIntake()] } as any);
    const review = vi.spyOn(lib.invoiceIntakeApi, "reviewIntake").mockResolvedValue({} as any);
    render(<InvoiceCostSetDetailPage params={{ id: "cs1" }} />);
    const panel = await screen.findByRole("region", { name: "Review 227552.pdf" });
    const p = within(panel);

    expect(p.getByText(/Evidence: “1,198 SEK”/)).toBeInTheDocument();
    expect(p.getByText(/low confidence \(50%\)/)).toBeInTheDocument();
    expect(p.getByLabelText("Platform")).toHaveStyle({ border: "2px solid #d9a441" });
    expect(within(p.getByRole("list", { name: "Checks" })).getAllByRole("listitem")).toHaveLength(2);

    await user.selectOptions(p.getByLabelText("Invoice type"), "transport");
    await user.click(p.getAllByRole("button", { name: "Remove" })[0]); // the lot
    await user.click(p.getByRole("button", { name: "Add fee" }));
    await user.type(p.getByLabelText("Fee 3 amount"), "300");
    await user.click(p.getByRole("button", { name: "Confirm review" }));

    await waitFor(() => expect(review).toHaveBeenCalledTimes(1));
    const [id, edits, confirm] = review.mock.calls[0];
    expect(id).toBe("in2");
    expect(confirm).toBe(true);
    expect(edits).toEqual({
      invoiceType: "transport",
      lots: [],
      fees: [...effective.fees, { type: "other", label: null, amount: 300, percent: null, lotNumber: null }],
    });
  });

  it("saves edits without confirming and sends nothing for unchanged fields", async () => {
    const user = userEvent.setup();
    vi.spyOn(lib.invoiceIntakeApi, "getCostSet").mockResolvedValue({ ...setRow, intakes: [extractedIntake()] } as any);
    const review = vi.spyOn(lib.invoiceIntakeApi, "reviewIntake").mockResolvedValue({} as any);
    render(<InvoiceCostSetDetailPage params={{ id: "cs1" }} />);
    const p = within(await screen.findByRole("region", { name: "Review 227552.pdf" }));
    await user.click(p.getByRole("button", { name: "Save edits" }));
    await waitFor(() => expect(review).toHaveBeenCalledWith("in2", {}, false));

    const total = p.getByLabelText("Total");
    await user.clear(total);
    await user.type(total, "1199");
    await user.click(p.getByRole("button", { name: "Save edits" }));
    await waitFor(() => expect(review).toHaveBeenLastCalledWith("in2", { total: 1199 }, false));
  });

  it("disables Confirm review while TOTAL_MISMATCH is present and shows the failed check in red", async () => {
    const checks = [{ code: "TOTAL_MISMATCH", ok: false, message: "Lots and fees add up to 1198.00, but the total is 1199.00" }];
    vi.spyOn(lib.invoiceIntakeApi, "getCostSet").mockResolvedValue({ ...setRow, intakes: [extractedIntake(checks)] } as any);
    render(<InvoiceCostSetDetailPage params={{ id: "cs1" }} />);
    const p = within(await screen.findByRole("region", { name: "Review 227552.pdf" }));
    expect(p.getByRole("button", { name: "Confirm review" })).toBeDisabled();
    expect(p.getByRole("button", { name: "Save edits" })).toBeEnabled();
    expect(p.getByText(/✗ Lots and fees add up to 1198.00/)).toHaveStyle({ color: "#c86a6a" });
  });

  it("shows the review read-only for a set that is not open", async () => {
    vi.spyOn(lib.invoiceIntakeApi, "getCostSet").mockResolvedValue({ ...setRow, status: "cancelled", intakes: [extractedIntake()] } as any);
    render(<InvoiceCostSetDetailPage params={{ id: "cs1" }} />);
    const p = within(await screen.findByRole("region", { name: "Review 227552.pdf" }));
    expect(p.getByLabelText("Total")).toBeDisabled();
    expect(p.queryByRole("button", { name: "Confirm review" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Read again" })).not.toBeInTheDocument();
  });
});
