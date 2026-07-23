// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as returnsLib from "@/lib/returns";
import RefundDetail from "./page";

afterEach(() => vi.restoreAllMocks());

const baseRefund = (overrides: Partial<returnsLib.RefundRow> = {}): returnsLib.RefundRow => ({
  id: "ref1",
  orderId: "ord1",
  type: "partial",
  status: "draft",
  currency: "EUR",
  subtotalAmount: 20,
  shippingAmount: 0,
  taxAmount: 0,
  totalAmount: 20,
  ...overrides,
});

async function renderPage(row: returnsLib.RefundRow) {
  vi.spyOn(returnsLib, "getRefund").mockResolvedValue(row);
  render(<RefundDetail params={{ id: row.id }} />);
  await screen.findByText(`Refund ${row.id}`);
}

describe("Refund detail lifecycle actions (Sprint 56B)", () => {
  it("shows submit for a Draft refund and hides retry/cancel-after-success actions accordingly", async () => {
    await renderPage(baseRefund({ status: "draft" }));
    expect(screen.getByText("Submit")).toBeInTheDocument();
    expect(screen.getByText("Cancel refund")).toBeInTheDocument();
    expect(screen.queryByText("Retry")).not.toBeInTheDocument();
  });

  it("shows retry for a Failed refund", async () => {
    await renderPage(baseRefund({ status: "failed" }));
    expect(screen.getByText("Retry")).toBeInTheDocument();
    expect(screen.getByText("Submit")).toBeInTheDocument();
  });

  it("hides submit, retry, and cancel for a Succeeded refund - no further action is possible", async () => {
    await renderPage(baseRefund({ status: "succeeded" }));
    expect(screen.queryByText("Submit")).not.toBeInTheDocument();
    expect(screen.queryByText("Retry")).not.toBeInTheDocument();
    expect(screen.queryByText("Cancel refund")).not.toBeInTheDocument();
  });

  it("requires confirmation before submitting", async () => {
    const user = userEvent.setup();
    const submit = vi.spyOn(returnsLib, "submitRefund").mockResolvedValue(baseRefund({ status: "pending" }));
    await renderPage(baseRefund({ status: "draft" }));
    await user.click(screen.getByText("Submit"));
    expect(submit).not.toHaveBeenCalled();
    await user.click(await screen.findByText("Confirm Submit"));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("ref1"));
  });

  it("disables the confirm button while submitting and prevents a duplicate submission", async () => {
    const user = userEvent.setup();
    let resolveRetry!: (v: returnsLib.RefundRow) => void;
    const retry = vi.spyOn(returnsLib, "retryRefund").mockReturnValue(new Promise((resolve) => { resolveRetry = resolve; }));
    await renderPage(baseRefund({ status: "failed" }));
    await user.click(screen.getByText("Retry"));
    const confirmBtn = await screen.findByText("Confirm Retry");
    await user.click(confirmBtn);
    await waitFor(() => expect(screen.getByText("Submitting…")).toBeDisabled());
    await user.click(screen.getByText("Submitting…"));
    expect(retry).toHaveBeenCalledTimes(1);
    resolveRetry(baseRefund({ status: "pending" }));
  });

  it("displays a plain backend failure message", async () => {
    const user = userEvent.setup();
    vi.spyOn(returnsLib, "cancelRefund").mockRejectedValue(new Error("Refund is not in a cancellable state"));
    await renderPage(baseRefund({ status: "draft" }));
    await user.click(screen.getByText("Cancel refund"));
    await user.click(screen.getByText("Confirm Cancel refund"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Refund is not in a cancellable state");
  });

  it("renders the payment-provider-not-configured limitation clearly rather than a generic error", async () => {
    await renderPage(baseRefund({ status: "failed", lastError: "PROVIDER_ERROR: REFUND_PAYMENT_PROVIDER_NOT_CONFIGURED" }));
    expect(screen.getByText(/no payment-provider integration is configured/)).toBeInTheDocument();
    expect(screen.queryByText(/^Last error:/)).not.toBeInTheDocument();
  });

  it("shows an ordinary last-error message plainly when it is not the provider-not-configured case", async () => {
    await renderPage(baseRefund({ status: "failed", lastError: "PROVIDER_RETRYABLE_FAILURE: gateway timeout" }));
    expect(screen.getByText(/Last error:/)).toBeInTheDocument();
    expect(screen.queryByText(/no payment-provider integration is configured/)).not.toBeInTheDocument();
  });

  it("reloads authoritative backend state after a success rather than fabricating the new status", async () => {
    const user = userEvent.setup();
    const getRefundSpy = vi.spyOn(returnsLib, "getRefund")
      .mockResolvedValueOnce(baseRefund({ status: "draft" }))
      .mockResolvedValueOnce(baseRefund({ status: "pending" }));
    vi.spyOn(returnsLib, "submitRefund").mockResolvedValue(baseRefund({ status: "pending" }));
    render(<RefundDetail params={{ id: "ref1" }} />);
    await screen.findByText(/Status draft/);
    await user.click(screen.getByText("Submit"));
    await user.click(screen.getByText("Confirm Submit"));
    await screen.findByText(/Status pending/);
    expect(getRefundSpy).toHaveBeenCalledTimes(2);
  });
});
