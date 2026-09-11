// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useCartFreshness,
  type CartFreshnessState,
} from "../components/CartFreshness";
import {
  clearCartPersisted,
  getCart,
  replaceCartPersisted,
  type CartItem,
} from "../lib/cart";
import type { CartReconciliationResult } from "../lib/cartReconciliation";

const mocks = vi.hoisted(() => ({ reconcileCart: vi.fn() }));
vi.mock("@/lib/cartReconciliation", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/cartReconciliation")>(),
  reconcileCart: mocks.reconcileCart,
}));

const itemA: CartItem = {
  productId: "a",
  slug: "a",
  title: "Item A",
  eurPrice: 10,
  quantity: 1,
  productType: "unique_item",
  allowCashOnDelivery: true,
};
const itemB: CartItem = { ...itemA, productId: "b", slug: "b", title: "Item B", eurPrice: 20 };
const refreshedA: CartItem = { ...itemA, title: "Refreshed A" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function result(
  previousItems: CartItem[],
  currentItems = previousItems,
  changes: CartReconciliationResult["changes"] = [],
  unavailableItems: CartReconciliationResult["unavailableItems"] = [],
): CartReconciliationResult {
  return { previousItems, currentItems, changes, unavailableItems };
}

let freshness: CartFreshnessState;

function Harness() {
  freshness = useCartFreshness();
  return (
    <div>
      <span data-testid="loading">{String(freshness.loading)}</span>
      <span data-testid="error">{String(freshness.error)}</span>
      <span data-testid="items">{freshness.items.map((item) => item.title).join(",")}</span>
      <span data-testid="changes">{freshness.result?.changes.length ?? 0}</span>
      <span data-testid="unavailable">{freshness.result?.unavailableItems.length ?? 0}</span>
    </div>
  );
}

describe("Sprint 171 cart reconciliation request ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    replaceCartPersisted([itemA]);
  });

  afterEach(cleanup);

  it("keeps a newer success authoritative when an older success resolves later", async () => {
    const older = deferred<CartReconciliationResult>();
    const newer = deferred<CartReconciliationResult>();
    mocks.reconcileCart.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    render(<Harness />);
    await waitFor(() => expect(mocks.reconcileCart).toHaveBeenCalledOnce());

    let newerRun!: ReturnType<CartFreshnessState["reconcileNow"]>;
    act(() => { newerRun = freshness.reconcileNow(); });
    await act(async () => { newer.resolve(result([itemA], [refreshedA])); await newerRun; });
    await act(async () => { older.resolve(result([itemA], [itemB])); await older.promise; });

    expect(screen.getByTestId("items").textContent).toBe("Refreshed A");
    expect(getCart()).toEqual([refreshedA]);
    expect(screen.getByTestId("error").textContent).toBe("false");
  });

  it("suppresses an older failure after a newer success", async () => {
    const older = deferred<CartReconciliationResult>();
    mocks.reconcileCart.mockReturnValueOnce(older.promise).mockResolvedValueOnce(result([itemA], [refreshedA]));
    render(<Harness />);
    await waitFor(() => expect(mocks.reconcileCart).toHaveBeenCalledOnce());

    await act(async () => { await freshness.reconcileNow(); });
    await act(async () => { older.reject(new Error("obsolete")); try { await older.promise; } catch {} });

    expect(screen.getByTestId("items").textContent).toBe("Refreshed A");
    expect(screen.getByTestId("error").textContent).toBe("false");
    expect(screen.getByTestId("loading").textContent).toBe("false");
  });

  it("does not let stale finalization end a newer pending run", async () => {
    const older = deferred<CartReconciliationResult>();
    const newer = deferred<CartReconciliationResult>();
    mocks.reconcileCart.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    render(<Harness />);
    await waitFor(() => expect(mocks.reconcileCart).toHaveBeenCalledOnce());
    act(() => { void freshness.reconcileNow(); });

    await act(async () => { older.resolve(result([itemA])); await older.promise; });
    expect(screen.getByTestId("loading").textContent).toBe("true");
    await act(async () => { newer.resolve(result([itemA])); await newer.promise; });
    expect(screen.getByTestId("loading").textContent).toBe("false");
  });

  it("keeps the cart empty when an empty fast path supersedes an old non-empty run", async () => {
    const older = deferred<CartReconciliationResult>();
    mocks.reconcileCart.mockReturnValueOnce(older.promise).mockResolvedValueOnce(result([]));
    render(<Harness />);
    await waitFor(() => expect(mocks.reconcileCart).toHaveBeenCalledOnce());

    clearCartPersisted();
    await act(async () => { await freshness.reconcileNow(); });
    await act(async () => { older.resolve(result([itemA], [refreshedA])); await older.promise; });

    expect(getCart()).toEqual([]);
    expect(screen.getByTestId("items").textContent).toBe("");
  });

  it("does not reintroduce items during rapid unavailable-item removal", async () => {
    const firstRemoval = deferred<CartReconciliationResult>();
    mocks.reconcileCart
      .mockResolvedValueOnce(result(
        [itemA, itemB],
        [itemA, itemB],
        [],
        [
          { productId: "a", title: "Item A", reason: "out_of_stock" },
          { productId: "b", title: "Item B", reason: "out_of_stock" },
        ],
      ))
      .mockReturnValueOnce(firstRemoval.promise)
      .mockResolvedValueOnce(result([]));
    replaceCartPersisted([itemA, itemB]);
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("unavailable").textContent).toBe("2"));

    act(() => {
      freshness.removeUnavailable("a");
      freshness.removeUnavailable("b");
    });
    await waitFor(() => expect(mocks.reconcileCart).toHaveBeenCalledTimes(3));
    await act(async () => { firstRemoval.resolve(result([itemB], [itemB])); await firstRemoval.promise; });

    expect(getCart()).toEqual([]);
    expect(screen.getByTestId("items").textContent).toBe("");
  });

  it("keeps clear-cart authoritative over an in-flight reconciliation", async () => {
    const older = deferred<CartReconciliationResult>();
    mocks.reconcileCart.mockReturnValueOnce(older.promise).mockResolvedValueOnce(result([]));
    render(<Harness />);
    await waitFor(() => expect(mocks.reconcileCart).toHaveBeenCalledOnce());
    clearCartPersisted();
    await act(async () => { await freshness.reconcileNow(); });
    await act(async () => { older.resolve(result([itemA], [itemB])); await older.promise; });
    expect(getCart()).toEqual([]);
  });

  it("gives retry ownership over older pending work", async () => {
    const older = deferred<CartReconciliationResult>();
    const retry = deferred<CartReconciliationResult>();
    mocks.reconcileCart.mockReturnValueOnce(older.promise).mockReturnValueOnce(retry.promise);
    render(<Harness />);
    await waitFor(() => expect(mocks.reconcileCart).toHaveBeenCalledOnce());
    act(() => { freshness.retry(); });
    await act(async () => { retry.resolve(result([itemA], [refreshedA])); await retry.promise; });
    await act(async () => { older.resolve(result([itemA], [itemB])); await older.promise; });
    expect(screen.getByTestId("items").textContent).toBe("Refreshed A");
    expect(getCart()).toEqual([refreshedA]);
  });

  it("preserves authoritative commerce-change consent", async () => {
    mocks.reconcileCart.mockResolvedValue(result(
      [itemA],
      [refreshedA],
      [{ productId: "a", title: "Refreshed A", previousPriceEur: 10, currentPriceEur: 12, codEligibilityChanged: false }],
    ));
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("changes").textContent).toBe("1"));
    expect(getCart()).toEqual([itemA]);
    act(() => { freshness.acceptChanges(); });
    expect(getCart()).toEqual([refreshedA]);
  });

  it("preserves authoritative unavailable-product blocking and removal", async () => {
    mocks.reconcileCart
      .mockResolvedValueOnce(result([itemA], [itemA], [], [{ productId: "a", title: "Item A", reason: "out_of_stock" }]))
      .mockResolvedValueOnce(result([]));
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("unavailable").textContent).toBe("1"));
    expect(freshness.canProceed).toBe(false);
    act(() => { freshness.removeUnavailable("a"); });
    await waitFor(() => expect(freshness.canProceed).toBe(true));
    expect(getCart()).toEqual([]);
  });

  it("returns fail-closed from an awaited run that is superseded", async () => {
    mocks.reconcileCart.mockResolvedValueOnce(result([itemA]));
    render(<Harness />);
    await waitFor(() => expect(freshness.canProceed).toBe(true));
    const older = deferred<CartReconciliationResult>();
    const newer = deferred<CartReconciliationResult>();
    mocks.reconcileCart.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);

    let olderRun!: ReturnType<CartFreshnessState["reconcileNow"]>;
    act(() => { olderRun = freshness.reconcileNow(); void freshness.reconcileNow(); });
    older.resolve(result([itemA], [refreshedA]));
    await expect(olderRun).resolves.toMatchObject({ canProceed: false });
    await act(async () => { newer.resolve(result([itemA])); await newer.promise; });
  });

  it("invalidates pending work on unmount before it can persist or dispatch", async () => {
    const pending = deferred<CartReconciliationResult>();
    const onUpdate = vi.fn();
    window.addEventListener("noctella:cart-updated", onUpdate);
    mocks.reconcileCart.mockReturnValue(pending.promise);
    const view = render(<Harness />);
    await waitFor(() => expect(mocks.reconcileCart).toHaveBeenCalledOnce());
    view.unmount();

    await act(async () => { pending.resolve(result([itemA], [refreshedA])); await pending.promise; });
    expect(getCart()).toEqual([itemA]);
    expect(onUpdate).not.toHaveBeenCalled();
    window.removeEventListener("noctella:cart-updated", onUpdate);
  });

  it("prevents an invalidated Strict Mode lifecycle from committing", async () => {
    const invalidated = deferred<CartReconciliationResult>();
    const current = deferred<CartReconciliationResult>();
    mocks.reconcileCart.mockReturnValueOnce(invalidated.promise).mockReturnValueOnce(current.promise);
    render(<StrictMode><Harness /></StrictMode>);
    await waitFor(() => expect(mocks.reconcileCart).toHaveBeenCalledTimes(2));

    await act(async () => { current.resolve(result([itemA], [refreshedA])); await current.promise; });
    await act(async () => { invalidated.resolve(result([itemA], [itemB])); await invalidated.promise; });
    expect(getCart()).toEqual([refreshedA]);
    expect(screen.getByTestId("items").textContent).toBe("Refreshed A");
  });
});
