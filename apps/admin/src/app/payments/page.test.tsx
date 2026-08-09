// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PaymentsPage from "./page";
import { listPaymentSessions } from "@/lib/payments";

vi.mock("@/lib/payments", () => ({ listPaymentSessions: vi.fn() }));

describe("Sprint 128 payment list", () => {
  beforeEach(() => vi.mocked(listPaymentSessions).mockResolvedValue([{ id: "payment-128", provider: "stripe", providerReference: "cs_test_128", status: "paid", amount: 10, currency: "EUR", orderId: null, createdAt: "2026-08-10T10:00:00.000Z", updatedAt: "2026-08-10T10:00:00.000Z" }]));
  it("links a payment row to its authenticated operational detail", async () => {
    render(<PaymentsPage />);
    expect(await screen.findByRole("link", { name: "stripe" })).toHaveAttribute("href", "/payments/payment-128");
  });
});
