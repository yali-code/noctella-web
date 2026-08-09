// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import PaymentDetailPage from "./page";
import { getPaymentOperationsDetail } from "@/lib/payments";

vi.mock("@/lib/payments", () => ({ getPaymentOperationsDetail: vi.fn() }));

const detail = { paymentId: "payment-128", provider: "stripe", status: "manual_refund_required", amount: 12.34, currency: "EUR", expectedAmountCents: 1234, providerReference: "cs_test_128", providerTransactionReference: "pi_test_128", orderId: null, createdAt: "2026-08-10T10:00:00.000Z", updatedAt: "2026-08-10T10:01:00.000Z", events: [{ id: "internal-event-128", providerEventId: "evt_test_128", eventType: "checkout.session.completed", status: "manual_refund_required", resultClassification: "price_changed", errorCode: "CHECKOUT_PRICE_CHANGED", createdAt: "2026-08-10T10:00:00.000Z", updatedAt: "2026-08-10T10:01:00.000Z" }] };

describe("Sprint 128 payment detail", () => {
  it("renders approved operational facts and guidance without a refund control or PII", async () => {
    vi.mocked(getPaymentOperationsDetail).mockResolvedValue(detail);
    render(<PaymentDetailPage params={{ id: "payment-128" }} />);
    expect(await screen.findByText(/cs_test_128/)).toBeInTheDocument();
    expect(screen.getByText(/pi_test_128/)).toBeInTheDocument();
    expect(screen.getByText("evt_test_128")).toBeInTheDocument();
    expect(screen.getByText("price_changed")).toBeInTheDocument();
    expect(screen.getByText("CHECKOUT_PRICE_CHANGED")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/Stripe Dashboard TEST MODE/);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/checkout snapshot|guest email|billing address|shipping address|private@example.com/i);
  });

  it("handles a missing payment response safely", async () => {
    vi.mocked(getPaymentOperationsDetail).mockRejectedValue(new Error("Payment not found"));
    render(<PaymentDetailPage params={{ id: "missing" }} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Payment not found");
  });
});
