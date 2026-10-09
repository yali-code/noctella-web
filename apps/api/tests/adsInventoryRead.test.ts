import { describe, expect, it, vi } from "vitest";
import { readAdsReservationAwareAvailability } from "../src/use-cases/ads/adsInventoryRead";

function reader(rows: Record<string, unknown>[]) {
  return { all: vi.fn(async (_query: unknown) => rows) };
}
const good = { product_id: "NOC-000007", physical_stock: 2, reserved_stock: 1, invalid_reservations: 0 };

describe("ADS-002C.3 read-only stock reservation reader", () => {
  it("returns reservation-verified availability based on existing inventory", async () => {
    const db = reader([good]);
    expect(await readAdsReservationAwareAvailability(db as never, "NOC-000007")).toEqual({
      productId: "NOC-000007", physicalStock: 2, reservedStock: 1,
      reservedStockSupported: true, availableStock: 1, availableQuantity: 1,
    });
    expect(db.all).toHaveBeenCalledTimes(1);
  });
  it("blocks over-reserved and negative quantities", async () => {
    for (const row of [
      { ...good, reserved_stock: 3 }, { ...good, physical_stock: -1 },
      { ...good, reserved_stock: -1 }, { ...good, reserved_stock: 1.5 },
      { ...good, physical_stock: null },
    ]) {
      expect(await readAdsReservationAwareAvailability(reader([row]) as never, "NOC-000007")).toBeNull();
    }
  });
  it("blocks invalid active reservations and mismatched stock identity", async () => {
    expect(await readAdsReservationAwareAvailability(reader([{ ...good, invalid_reservations: 1 }]) as never, "NOC-000007")).toBeNull();
    expect(await readAdsReservationAwareAvailability(reader([{ ...good, product_id: "OTHER" }]) as never, "NOC-000007")).toBeNull();
    expect(await readAdsReservationAwareAvailability(reader([]) as never, "NOC-000007")).toBeNull();
  });
  it("never accesses database for unsafe IDs", async () => {
    const db = reader([good]);
    expect(await readAdsReservationAwareAvailability(db as never, "../bad")).toBeNull();
    expect(db.all).not.toHaveBeenCalled();
  });
  it("uses only a SELECT; does not expire or update reservations", async () => {
    const db = reader([good]);
    await readAdsReservationAwareAvailability(db as never, "NOC-000007");
    const query = db.all.mock.calls[0]?.[0] as { queryChunks?: unknown[] };
    const sqlText = JSON.stringify(query).toLowerCase();
    expect(sqlText).toContain("select");
    expect(sqlText).not.toContain("update stock_reservations");
    expect(sqlText).not.toContain("delete from");
  });
});
