// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as stock from "@/lib/stock";
import ProductStockPage from "./page";

vi.mock("next/navigation", () => ({ useParams: () => ({ productId: "p" }) }));
afterEach(() => vi.restoreAllMocks());

it("keeps the existing timeline and manual adjustment request behavior", async () => {
  const user = userEvent.setup();
  const load = vi.spyOn(stock, "listStockMovements").mockResolvedValue({ items: [{ id: "m", productId: "p", type: "manual_adjustment", quantityDelta: 1, stockBefore: 0, stockAfter: 1, note: "Product creation stock quantity", createdAt: "2026-09-01T10:00:00Z" }] as any, total: 1, page: 1, pageSize: 100 });
  const adjust = vi.spyOn(stock, "createStockAdjustment").mockResolvedValue({} as any);
  render(<ProductStockPage />);
  expect(await screen.findByText("Product creation stock quantity")).toBeInTheDocument();
  await user.clear(screen.getByLabelText("Quantity delta"));
  await user.type(screen.getByLabelText("Quantity delta"), "2");
  await user.type(screen.getByLabelText("Adjustment note"), "Count correction");
  await user.click(screen.getByRole("button", { name: "Apply adjustment" }));
  await waitFor(() => expect(adjust).toHaveBeenCalledExactlyOnceWith({ productId: "p", quantityDelta: 2, note: "Count correction" }));
  expect(load).toHaveBeenCalledWith("p", 1);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
});

it("shows timeline entries beyond the first 100 movements", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: `m${index}`, productId: "p", type: "manual_adjustment", quantityDelta: 1, stockBefore: index, stockAfter: index + 1, createdAt: "2026-09-01T10:00:00Z" }));
  const load = vi.spyOn(stock, "listStockMovements")
    .mockResolvedValueOnce({ items: firstPage as any, total: 101, page: 1, pageSize: 100 })
    .mockResolvedValueOnce({ items: [{ ...firstPage[0], id: "last", note: "Movement 101" }] as any, total: 101, page: 2, pageSize: 100 });
  render(<ProductStockPage />);
  expect(await screen.findByText("Movement 101")).toBeInTheDocument();
  expect(load).toHaveBeenLastCalledWith("p", 2);
});
