// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PublishChannel } from "@noctella/shared";
import { ApiError } from "@/lib/api";
import * as apiLib from "@/lib/api";
import * as marketplacesLib from "@/lib/marketplaces";
import ReadyToPublishPage from "./page";

afterEach(() => vi.restoreAllMocks());

function product(overrides: Record<string, unknown> = {}) {
  return {
    id: "product-1",
    sku: "NOC-000145",
    title: "Konica EU Mini",
    categoryId: "cat-1",
    status: "approved",
    priceEur: 120,
    stockQuantity: 1,
    updatedAt: "2026-08-12T00:00:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

const categoriesResponse = {
  items: [{ id: "cat-1", name: "Camera", displayOrder: 0, isActive: true, createdAt: "t", updatedAt: "t" }],
  total: 1,
  page: 1,
  pageSize: 100,
};

/** Mocks GET /api/categories and GET /api/products (default: one Approved product). */
function mockLoads(productsResult: Record<string, unknown> = { items: [product()], total: 1, page: 1, pageSize: 20 }) {
  return vi.spyOn(apiLib.api, "get").mockImplementation((path: string) => {
    if (path.startsWith("/api/categories")) return Promise.resolve(categoriesResponse) as any;
    if (path.startsWith("/api/products")) return Promise.resolve(productsResult) as any;
    return Promise.reject(new Error(`Unexpected path: ${path}`));
  });
}

describe("Ready to Publish page (Sprint 136)", () => {
  it("requests products with status=approved", async () => {
    const getSpy = mockLoads();
    render(<ReadyToPublishPage />);
    await screen.findByText("Konica EU Mini");
    const productCall = getSpy.mock.calls.find(([path]) => (path as string).startsWith("/api/products"));
    expect(productCall?.[0]).toContain("status=approved");
  });

  it("renders Approved products returned by the authoritative endpoint", async () => {
    mockLoads({ items: [product(), product({ id: "product-2", sku: "NOC-000146", title: "Seiko 5" })], total: 2, page: 1, pageSize: 20 });
    render(<ReadyToPublishPage />);
    expect(await screen.findByText("Konica EU Mini")).toBeInTheDocument();
    expect(screen.getByText("Seiko 5")).toBeInTheDocument();
  });

  it("does not fabricate or locally merge non-approved products - renders exactly what the endpoint returns", async () => {
    mockLoads({ items: [product()], total: 1, page: 1, pageSize: 20 });
    render(<ReadyToPublishPage />);
    await screen.findByText("Konica EU Mini");
    expect(screen.getAllByRole("row")).toHaveLength(2); // header row + one product row
  });

  it("renders the product title", async () => {
    mockLoads();
    render(<ReadyToPublishPage />);
    expect(await screen.findByText("Konica EU Mini")).toBeInTheDocument();
  });

  it("renders the SKU", async () => {
    mockLoads();
    render(<ReadyToPublishPage />);
    await screen.findByText("Konica EU Mini");
    expect(screen.getByText("NOC-000145")).toBeInTheDocument();
  });

  it("resolves and renders the Category name from categoryId", async () => {
    mockLoads();
    render(<ReadyToPublishPage />);
    const row = (await screen.findByText("Konica EU Mini")).closest("tr")!;
    expect(within(row).getByText("Camera")).toBeInTheDocument();
  });

  it("renders the primary thumbnail when present", async () => {
    mockLoads({ items: [product({ primaryImageUrl: "/images/product-photos/konica.webp" })], total: 1, page: 1, pageSize: 20 });
    render(<ReadyToPublishPage />);
    const row = (await screen.findByText("Konica EU Mini")).closest("tr")!;
    const img = row.querySelector("img");
    expect(img).toHaveAttribute("src", expect.stringContaining("konica.webp"));
  });

  it("search updates the backend query and resets to page 1", async () => {
    const user = userEvent.setup();
    const getSpy = mockLoads();
    render(<ReadyToPublishPage />);
    await screen.findByText("Konica EU Mini");
    getSpy.mockClear();
    await user.type(screen.getByPlaceholderText("Search title or SKU"), "Konica");
    await waitFor(() => {
      const lastProductCall = getSpy.mock.calls.filter(([path]) => (path as string).startsWith("/api/products")).at(-1);
      expect(lastProductCall?.[0]).toContain("search=Konica");
      expect(lastProductCall?.[0]).toContain("page=1");
    });
  });

  it("category filter updates the backend query and resets to page 1", async () => {
    const user = userEvent.setup();
    const getSpy = mockLoads();
    render(<ReadyToPublishPage />);
    await screen.findByText("Konica EU Mini");
    getSpy.mockClear();
    await user.selectOptions(await screen.findByDisplayValue("All categories"), "cat-1");
    await waitFor(() => {
      const lastProductCall = getSpy.mock.calls.filter(([path]) => (path as string).startsWith("/api/products")).at(-1);
      expect(lastProductCall?.[0]).toContain("categoryId=cat-1");
      expect(lastProductCall?.[0]).toContain("page=1");
    });
  });

  it("pagination works using the returned total/page/pageSize", async () => {
    const user = userEvent.setup();
    const getSpy = mockLoads({ items: [product()], total: 21, page: 1, pageSize: 20 });
    render(<ReadyToPublishPage />);
    await screen.findByText("Konica EU Mini");
    expect(screen.getByText(/Page 1 of 2/)).toBeInTheDocument();
    getSpy.mockClear();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => {
      const lastProductCall = getSpy.mock.calls.filter(([path]) => (path as string).startsWith("/api/products")).at(-1);
      expect(lastProductCall?.[0]).toContain("page=2");
    });
  });

  it("Preview link is exactly /products/[id]/publishing", async () => {
    mockLoads();
    render(<ReadyToPublishPage />);
    await screen.findByText("Konica EU Mini");
    expect(screen.getByRole("link", { name: "Preview" })).toHaveAttribute("href", "/products/product-1/publishing");
  });

  it("Edit link is exactly /products/[id]/edit", async () => {
    mockLoads();
    render(<ReadyToPublishPage />);
    await screen.findByText("Konica EU Mini");
    expect(screen.getByRole("link", { name: "Edit" })).toHaveAttribute("href", "/products/product-1/edit");
  });

  it("Publish calls marketplaceApi.executePublish(id, PublishChannel.NoctellaWeb)", async () => {
    const user = userEvent.setup();
    mockLoads();
    const executeSpy = vi.spyOn(marketplacesLib.marketplaceApi, "executePublish").mockResolvedValue({ job: {} } as any);
    render(<ReadyToPublishPage />);
    await screen.findByText("Konica EU Mini");
    await user.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(executeSpy).toHaveBeenCalledWith("product-1", PublishChannel.NoctellaWeb));
  });

  it("Publish button is protected against repeated clicks while that row is publishing", async () => {
    const user = userEvent.setup();
    mockLoads();
    let resolveExecute: (value: any) => void;
    const executeSpy = vi.spyOn(marketplacesLib.marketplaceApi, "executePublish").mockImplementation(
      () => new Promise<any>((resolve) => { resolveExecute = resolve; }),
    );
    render(<ReadyToPublishPage />);
    await screen.findByText("Konica EU Mini");
    const button = screen.getByRole("button", { name: "Publish" });
    await user.click(button);
    expect(screen.getByRole("button", { name: "Publishing..." })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Publishing..." }));
    expect(executeSpy).toHaveBeenCalledTimes(1);
    resolveExecute!({ job: {} });
  });

  it("successful Publish removes the product from the visible queue and updates the total", async () => {
    const user = userEvent.setup();
    mockLoads({ items: [product(), product({ id: "product-2", sku: "NOC-000146", title: "Seiko 5" })], total: 2, page: 1, pageSize: 20 });
    vi.spyOn(marketplacesLib.marketplaceApi, "executePublish").mockResolvedValue({ job: {} } as any);
    render(<ReadyToPublishPage />);
    await screen.findByText("Konica EU Mini");
    const row = screen.getByText("Konica EU Mini").closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(screen.queryByText("Konica EU Mini")).not.toBeInTheDocument());
    expect(screen.getByText("Seiko 5")).toBeInTheDocument();
    expect(screen.getByText(/\(1 total\)/)).toBeInTheDocument();
  });

  it("Publish failure keeps the product visible and shows the returned safe error", async () => {
    const user = userEvent.setup();
    mockLoads();
    vi.spyOn(marketplacesLib.marketplaceApi, "executePublish").mockRejectedValue(
      new ApiError("Publish validation failed", 400),
    );
    render(<ReadyToPublishPage />);
    await screen.findByText("Konica EU Mini");
    await user.click(screen.getByRole("button", { name: "Publish" }));
    await screen.findByText("Publish validation failed");
    expect(screen.getByText("Konica EU Mini")).toBeInTheDocument();
  });

  it("renders a clear empty state and never fabricates unrelated non-approved products", async () => {
    mockLoads({ items: [], total: 0, page: 1, pageSize: 20 });
    render(<ReadyToPublishPage />);
    expect(await screen.findByText("No products are ready to publish.")).toBeInTheDocument();
  });
});

/**
 * Sprint 136 correction (Exact Review Required Fixes #1 and #2): the previous single-scalar
 * publishingId and closure-captured items array both broke down specifically when two different
 * rows were published concurrently - a scenario the single-row tests above cannot exercise (they
 * pass unchanged against both the broken and corrected implementation). These tests exercise the
 * actual multi-row state transitions that defeated the previous implementation.
 */
describe("Ready to Publish page - multi-row publish concurrency (Sprint 136 correction)", () => {
  function twoProducts() {
    return {
      items: [product(), product({ id: "product-2", sku: "NOC-000146", title: "Seiko 5" })],
      total: 2,
      page: 1,
      pageSize: 20,
    };
  }

  it("1. different rows remain independently disabled - publishing B does not re-enable A", async () => {
    const user = userEvent.setup();
    mockLoads(twoProducts());
    vi.spyOn(marketplacesLib.marketplaceApi, "executePublish").mockImplementation(() => new Promise(() => {}));
    render(<ReadyToPublishPage />);
    await screen.findByText("Konica EU Mini");
    const rowA = screen.getByText("Konica EU Mini").closest("tr")!;
    const rowB = screen.getByText("Seiko 5").closest("tr")!;

    await user.click(within(rowA).getByRole("button", { name: "Publish" }));
    expect(within(rowA).getByRole("button")).toBeDisabled();
    expect(within(rowB).getByRole("button")).not.toBeDisabled();

    await user.click(within(rowB).getByRole("button", { name: "Publish" }));
    expect(within(rowA).getByRole("button")).toBeDisabled();
    expect(within(rowB).getByRole("button")).toBeDisabled();
  });

  it("2. the same product cannot be re-published while its first request is pending, even after a different row was published", async () => {
    const user = userEvent.setup();
    mockLoads(twoProducts());
    const executeSpy = vi.spyOn(marketplacesLib.marketplaceApi, "executePublish").mockImplementation(() => new Promise(() => {}));
    render(<ReadyToPublishPage />);
    await screen.findByText("Konica EU Mini");
    const rowA = screen.getByText("Konica EU Mini").closest("tr")!;
    const rowB = screen.getByText("Seiko 5").closest("tr")!;

    await user.click(within(rowA).getByRole("button", { name: "Publish" }));
    await user.click(within(rowB).getByRole("button", { name: "Publish" }));
    // This is the exact transition that defeated the previous scalar publishingId: under the old
    // implementation, clicking B overwrote publishingId from "product-1" to "product-2", which made
    // row A's own `disabled={publishingId === item.id}` re-evaluate to false - a real click here
    // would genuinely have gone through and fired a second executePublish("product-1", ...) call.
    // Attempting the same interaction against the corrected Set-based state must still leave row A
    // disabled and must not add a second call for product-1.
    expect(within(rowA).getByRole("button")).toBeDisabled();
    await user.click(within(rowA).getByRole("button"));

    const callsForProductA = executeSpy.mock.calls.filter(([id]) => id === "product-1");
    expect(callsForProductA).toHaveLength(1);
  });

  it("3. out-of-order multi-row success does not resurrect either product and both are removed", async () => {
    const user = userEvent.setup();
    mockLoads(twoProducts());
    let resolveA: (value: any) => void;
    let resolveB: (value: any) => void;
    vi.spyOn(marketplacesLib.marketplaceApi, "executePublish").mockImplementation((id: string) => {
      if (id === "product-1") return new Promise((resolve) => { resolveA = resolve; });
      return new Promise((resolve) => { resolveB = resolve; });
    });
    render(<ReadyToPublishPage />);
    await screen.findByText("Konica EU Mini");
    const rowA = screen.getByText("Konica EU Mini").closest("tr")!;
    const rowB = screen.getByText("Seiko 5").closest("tr")!;

    await user.click(within(rowA).getByRole("button", { name: "Publish" }));
    await user.click(within(rowB).getByRole("button", { name: "Publish" }));

    // B resolves first.
    resolveB!({ job: {} });
    await waitFor(() => expect(screen.queryByText("Seiko 5")).not.toBeInTheDocument());
    expect(screen.getByText(/\(1 total\)/)).toBeInTheDocument();

    // A resolves second - must not resurrect the already-removed B, and total must reflect both.
    resolveA!({ job: {} });
    await waitFor(() => expect(screen.queryByText("Konica EU Mini")).not.toBeInTheDocument());
    expect(screen.queryByText("Seiko 5")).not.toBeInTheDocument();
    expect(screen.getByText(/\(0 total\)/)).toBeInTheDocument();
  });

  it("4. a fresh search fetch that resolves while an unrelated publish is still pending is not overwritten by that publish's completion", async () => {
    const user = userEvent.setup();
    const getSpy = mockLoads(twoProducts());
    let resolveA: (value: any) => void;
    vi.spyOn(marketplacesLib.marketplaceApi, "executePublish").mockImplementation(
      () => new Promise((resolve) => { resolveA = resolve; }),
    );
    render(<ReadyToPublishPage />);
    await screen.findByText("Konica EU Mini");
    const rowA = screen.getByText("Konica EU Mini").closest("tr")!;

    // Start publishing A, but do not resolve it yet.
    await user.click(within(rowA).getByRole("button", { name: "Publish" }));

    // A fresh, unrelated search now resolves with a completely different result set while A's
    // publish is still in flight.
    getSpy.mockImplementation((path: string) => {
      if (path.startsWith("/api/categories")) return Promise.resolve(categoriesResponse) as any;
      return Promise.resolve({ items: [product({ id: "product-3", sku: "NOC-000147", title: "Leica Standard" })], total: 1, page: 1, pageSize: 20 }) as any;
    });
    await user.type(screen.getByPlaceholderText("Search title or SKU"), "Leica");
    await screen.findByText("Leica Standard");
    expect(screen.queryByText("Konica EU Mini")).not.toBeInTheDocument();
    expect(screen.queryByText("Seiko 5")).not.toBeInTheDocument();

    // A's publish (for a product no longer even in the visible list) now resolves. Because the
    // success handler uses a functional setItems update, filtering "product-1" out of whatever the
    // CURRENT array is, this must leave the fresh search result completely intact rather than
    // reverting to a stale pre-search array.
    //
    // resolveA is wrapped in act() and awaited so handlePublish's continuation actually runs and
    // commits before the assertions below - a plain `resolveA!(...)` followed immediately by
    // `waitFor` would give a false pass here, since waitFor's own first (synchronous) check would
    // already see "Leica Standard" present from BEFORE this resolution, succeeding immediately
    // without ever observing whether the later continuation corrupted state.
    await act(async () => {
      resolveA!({ job: {} });
    });
    expect(screen.getByText("Leica Standard")).toBeInTheDocument();
    expect(screen.queryByText("Konica EU Mini")).not.toBeInTheDocument();
    expect(screen.queryByText("Seiko 5")).not.toBeInTheDocument();
  });

  it("5. one row's publish failure releases only that row's in-flight state and its own error, leaving a concurrently pending row untouched", async () => {
    const user = userEvent.setup();
    mockLoads(twoProducts());
    let rejectA: (err: unknown) => void;
    let resolveB: (value: any) => void;
    vi.spyOn(marketplacesLib.marketplaceApi, "executePublish").mockImplementation((id: string) => {
      if (id === "product-1") return new Promise((_resolve, reject) => { rejectA = reject; });
      return new Promise((resolve) => { resolveB = resolve; });
    });
    render(<ReadyToPublishPage />);
    await screen.findByText("Konica EU Mini");
    const rowA = screen.getByText("Konica EU Mini").closest("tr")!;
    const rowB = screen.getByText("Seiko 5").closest("tr")!;

    // Both A and B genuinely pending simultaneously at this point - neither has settled yet.
    await user.click(within(rowA).getByRole("button", { name: "Publish" }));
    await user.click(within(rowB).getByRole("button", { name: "Publish" }));
    expect(within(rowA).getByRole("button")).toBeDisabled();
    expect(within(rowB).getByRole("button")).toBeDisabled();

    await act(async () => {
      rejectA!(new ApiError("Publish validation failed", 400));
    });

    await within(rowA).findByText("Publish validation failed");
    // A's own in-flight state is released (button re-enabled, back to "Publish")...
    expect(within(rowA).getByRole("button", { name: "Publish" })).not.toBeDisabled();
    // ...but B is untouched - still pending, still disabled, no error of its own.
    expect(within(rowB).getByRole("button", { name: "Publishing..." })).toBeDisabled();
    expect(within(rowB).queryByRole("alert")).not.toBeInTheDocument();

    await act(async () => {
      resolveB!({ job: {} });
    });
    await waitFor(() => expect(screen.queryByText("Seiko 5")).not.toBeInTheDocument());
    // A remains visible with its error after B independently completes.
    expect(screen.getByText("Konica EU Mini")).toBeInTheDocument();
  });
});
