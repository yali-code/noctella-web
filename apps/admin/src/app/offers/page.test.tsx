// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OfferStatus } from "@noctella/shared";
import * as offersLib from "@/lib/offers";
import OffersPage from "./page";

afterEach(() => vi.restoreAllMocks());

function baseOffer(overrides: any = {}): any {
  return {
    id: "offer-1",
    productId: "product-1",
    customerName: "Jane Collector",
    customerEmail: "jane@example.com",
    offeredAmount: 900,
    currency: "EUR",
    status: OfferStatus.Pending,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("Admin offers page", () => {
  it("loads and displays offers with buyer, amount, product, and status", async () => {
    vi.spyOn(offersLib.offersApi, "list").mockResolvedValue([baseOffer()]);
    render(<OffersPage />);

    await screen.findByText("product-1");
    expect(screen.getByText(/Jane Collector/)).toBeInTheDocument();
    expect(screen.getByText(/jane@example\.com/)).toBeInTheDocument();
    expect(screen.getByText("900")).toBeInTheDocument();
    expect(screen.getByText("EUR")).toBeInTheDocument();
    expect(screen.getByText(OfferStatus.Pending)).toBeInTheDocument();
  });

  it("renders no offer rows when the list is empty", async () => {
    vi.spyOn(offersLib.offersApi, "list").mockResolvedValue([]);
    render(<OffersPage />);
    await waitFor(() => expect(offersLib.offersApi.list).toHaveBeenCalled());
    expect(screen.queryAllByRole("row")).toHaveLength(1); // header row only, no data rows
  });

  it("shows the backend error message when loading offers fails", async () => {
    vi.spyOn(offersLib.offersApi, "list").mockRejectedValue(new Error("Failed to reach the offers API"));
    render(<OffersPage />);
    await screen.findByText("Failed to reach the offers API");
  });

  it("Pending offers show Accept/Reject, not a Draft Order action", async () => {
    vi.spyOn(offersLib.offersApi, "list").mockResolvedValue([baseOffer({ status: OfferStatus.Pending })]);
    render(<OffersPage />);
    await screen.findByText("Accept");
    expect(screen.getByText("Reject")).toBeInTheDocument();
    expect(screen.queryByText("Create Draft Order")).not.toBeInTheDocument();
  });

  it("Accept calls offersApi.accept and reloads the offer list", async () => {
    const user = userEvent.setup();
    const listSpy = vi
      .spyOn(offersLib.offersApi, "list")
      .mockResolvedValueOnce([baseOffer({ status: OfferStatus.Pending })])
      .mockResolvedValueOnce([baseOffer({ status: OfferStatus.Accepted })]);
    const acceptSpy = vi.spyOn(offersLib.offersApi, "accept").mockResolvedValue(baseOffer({ status: OfferStatus.Accepted }));
    render(<OffersPage />);

    await screen.findByText("Accept");
    await user.click(screen.getByText("Accept"));

    await waitFor(() => expect(acceptSpy).toHaveBeenCalledWith("offer-1"));
    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(2));
    await screen.findByText("Create Draft Order");
  });

  it("Reject calls offersApi.reject and reloads the offer list", async () => {
    const user = userEvent.setup();
    const listSpy = vi
      .spyOn(offersLib.offersApi, "list")
      .mockResolvedValueOnce([baseOffer({ status: OfferStatus.Pending })])
      .mockResolvedValueOnce([baseOffer({ status: OfferStatus.Rejected })]);
    const rejectSpy = vi.spyOn(offersLib.offersApi, "reject").mockResolvedValue(baseOffer({ status: OfferStatus.Rejected }));
    render(<OffersPage />);

    await screen.findByText("Reject");
    await user.click(screen.getByText("Reject"));

    await waitFor(() => expect(rejectSpy).toHaveBeenCalledWith("offer-1"));
    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(2));
  });

  it("shows the backend error message when Accept fails, and does not create a Draft Order link", async () => {
    const user = userEvent.setup();
    vi.spyOn(offersLib.offersApi, "list").mockResolvedValue([baseOffer({ status: OfferStatus.Pending })]);
    vi.spyOn(offersLib.offersApi, "accept").mockRejectedValue(new Error("Offer is already terminal"));
    render(<OffersPage />);

    await screen.findByText("Accept");
    await user.click(screen.getByText("Accept"));

    await screen.findByText("Offer is already terminal");
    expect(screen.queryByText("View Draft Order")).not.toBeInTheDocument();
  });

  it("Accepted offers show a Create Draft Order button that calls offersApi.createDraftOrder", async () => {
    const user = userEvent.setup();
    vi.spyOn(offersLib.offersApi, "list").mockResolvedValue([baseOffer({ status: OfferStatus.Accepted })]);
    const createSpy = vi
      .spyOn(offersLib.offersApi, "createDraftOrder")
      .mockResolvedValue({ id: "order-1", orderNumber: "NOC-20260101-000001" });
    render(<OffersPage />);

    await screen.findByText("Create Draft Order");
    await user.click(screen.getByText("Create Draft Order"));

    await waitFor(() => expect(createSpy).toHaveBeenCalledWith("offer-1"));
    const link = await screen.findByText("View Draft Order");
    expect(link.closest("a")).toHaveAttribute("href", "/orders/order-1");
  });

  it("shows the backend error message when Create Draft Order fails", async () => {
    const user = userEvent.setup();
    vi.spyOn(offersLib.offersApi, "list").mockResolvedValue([baseOffer({ status: OfferStatus.Accepted })]);
    vi.spyOn(offersLib.offersApi, "createDraftOrder").mockRejectedValue(new Error("Offer already has a Draft Order"));
    render(<OffersPage />);

    await screen.findByText("Create Draft Order");
    await user.click(screen.getByText("Create Draft Order"));

    await screen.findByText("Offer already has a Draft Order");
  });
});
