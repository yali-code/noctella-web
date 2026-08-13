// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as apiLib from "@/lib/api";
import ReadyToPublishPage from "./page";

afterEach(() => vi.restoreAllMocks());

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: "product-1",
    title: "Konica EU Mini",
    stockAcceptedAt: "2026-10-08T09:15:00.000Z",
    ...overrides,
  };
}

const categoriesResponse = {
  items: [
    { id: "cat-1", name: "Cameras", displayOrder: 0, isActive: true, createdAt: "t", updatedAt: "t" },
    { id: "cat-2", name: "Watches", displayOrder: 1, isActive: true, createdAt: "t", updatedAt: "t" },
  ],
  total: 2,
  page: 1,
  pageSize: 100,
};

/** Mocks GET /api/products/pending-publish (default: one eligible item) and GET /api/categories. */
function mockLoads(result: Record<string, unknown> = { items: [item()], total: 1, page: 1, pageSize: 20 }) {
  return vi.spyOn(apiLib.api, "get").mockImplementation((path: string) => {
    if (path.startsWith("/api/products/pending-publish")) return Promise.resolve(result) as any;
    if (path.startsWith("/api/categories")) return Promise.resolve(categoriesResponse) as any;
    return Promise.reject(new Error(`Unexpected path: ${path}`));
  });
}

/**
 * Sprint 139: Pending Publish - replaces Sprint 136's Ready to Publish suite. The previous suite
 * exercised an inline Publish button and per-row publishingIds/itemsRef concurrency state that no
 * longer exist on this page - membership and the row action both changed per the approved Sprint
 * 139 contract (Stock Acceptance provenance eligibility; a single navigation-only row action link,
 * never an in-page mutation). Covers the required Phase 6 contract points that are observable from
 * this page: title, requires GET /api/products/pending-publish (never the old status=approved
 * endpoint), DD.MM.YYYY Stock Accepted rendering derived from stockAcceptedAt (never createdAt),
 * the row action's link target (Sprint 144: /products/:id/edit, labeled "Edit Product" - was
 * "Edit / Publish" -> /publishing until Sprint 144 moved editing to the canonical Edit route), no
 * duplicate rows, no mutation on load/render, and the empty state.
 */
describe("Pending Publish page (Sprint 139)", () => {
  it("renders the Pending Publish title", async () => {
    mockLoads();
    render(<ReadyToPublishPage />);
    expect(await screen.findByText("Pending Publish")).toBeInTheDocument();
  });

  it("requests the dedicated Pending Publish read model, never the old status=approved endpoint", async () => {
    const getSpy = mockLoads();
    render(<ReadyToPublishPage />);
    await screen.findByText("Konica EU Mini");
    const call = getSpy.mock.calls.find(([path]) => (path as string).startsWith("/api/products"));
    expect(call?.[0]).toContain("/api/products/pending-publish");
    expect(call?.[0]).not.toContain("status=approved");
  });

  it("renders exactly what the endpoint returns - Product Name / Stock Accepted / Action columns only", async () => {
    mockLoads();
    render(<ReadyToPublishPage />);
    expect(await screen.findByText("Product Name")).toBeInTheDocument();
    expect(screen.getByText("Stock Accepted")).toBeInTheDocument();
    expect(screen.getByText("Action")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(2); // header row + one item row
  });

  it("renders the Stock Accepted date as DD.MM.YYYY, derived from stockAcceptedAt (never a fabricated or shifted date)", async () => {
    mockLoads({ items: [item({ stockAcceptedAt: "2026-10-08T23:50:00.000Z" })], total: 1, page: 1, pageSize: 20 });
    render(<ReadyToPublishPage />);
    expect(await screen.findByText("08.10.2026")).toBeInTheDocument();
  });

  it("renders multiple distinct Stock-Accepted items without duplication", async () => {
    mockLoads({
      items: [item(), item({ id: "product-2", title: "Seiko 5", stockAcceptedAt: "2026-10-09T00:00:00.000Z" })],
      total: 2,
      page: 1,
      pageSize: 20,
    });
    render(<ReadyToPublishPage />);
    expect(await screen.findByText("Konica EU Mini")).toBeInTheDocument();
    expect(screen.getByText("Seiko 5")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });

  it("Sprint 144: Edit Product links to the canonical Product Edit route for that Product, and only that", async () => {
    mockLoads();
    render(<ReadyToPublishPage />);
    await screen.findByText("Konica EU Mini");
    expect(screen.getByRole("link", { name: "Edit Product" })).toHaveAttribute("href", "/products/product-1/edit");
  });

  it("Edit Product is a plain navigation link - no button, no publish call, no mutation from this page", async () => {
    mockLoads();
    render(<ReadyToPublishPage />);
    await screen.findByText("Konica EU Mini");
    expect(screen.queryByRole("button", { name: /publish/i })).not.toBeInTheDocument();
  });

  it("search updates the backend query and resets to page 1", async () => {
    const user = userEvent.setup();
    const getSpy = mockLoads();
    render(<ReadyToPublishPage />);
    await screen.findByText("Konica EU Mini");
    getSpy.mockClear();
    await user.type(screen.getByPlaceholderText("Search title"), "Konica");
    await waitFor(() => {
      const lastCall = getSpy.mock.calls.filter(([path]) => (path as string).startsWith("/api/products")).at(-1);
      expect(lastCall?.[0]).toContain("search=Konica");
      expect(lastCall?.[0]).toContain("page=1");
    });
  });

  it("pagination works using the returned total/page/pageSize", async () => {
    const user = userEvent.setup();
    const getSpy = mockLoads({ items: [item()], total: 21, page: 1, pageSize: 20 });
    render(<ReadyToPublishPage />);
    await screen.findByText("Konica EU Mini");
    expect(screen.getByText(/Page 1 of 2/)).toBeInTheDocument();
    getSpy.mockClear();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => {
      const lastCall = getSpy.mock.calls.filter(([path]) => (path as string).startsWith("/api/products")).at(-1);
      expect(lastCall?.[0]).toContain("page=2");
    });
  });

  it("renders a clear empty state and never fabricates a waiting product", async () => {
    mockLoads({ items: [], total: 0, page: 1, pageSize: 20 });
    render(<ReadyToPublishPage />);
    expect(await screen.findByText("No products are waiting to be published.")).toBeInTheDocument();
  });

  it("renders an error state when the read model cannot be loaded, without crashing or fabricating rows", async () => {
    vi.spyOn(apiLib.api, "get").mockRejectedValue(new Error("Failed to load Pending Publish products"));
    render(<ReadyToPublishPage />);
    expect(await screen.findByText(/Failed to load Pending Publish products/)).toBeInTheDocument();
  });
});

/**
 * Required Fix #1: the Category filter (a filter control, not a table column) was unintentionally
 * dropped from the original Sprint 139 pass and is restored here - same mechanics as the Sprint
 * 136 baseline (load categories once, "" = all, reset page to 1 on change), now sent to the
 * dedicated GET /api/products/pending-publish endpoint. Backend combination with Stock Acceptance
 * provenance/eligibility is covered by the API-level pendingPublishQueueSprint139 tests, not here -
 * this page-level suite only proves the request is built and page state is reset correctly.
 */
describe("Pending Publish page - Category filter (Sprint 139 Required Fix #1)", () => {
  it("1. the Category filter is rendered with the loaded categories", async () => {
    mockLoads();
    render(<ReadyToPublishPage />);
    await screen.findByText("Konica EU Mini");
    const select = await screen.findByDisplayValue("All categories");
    expect(select).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Cameras" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Watches" })).toBeInTheDocument();
  });

  it("2. selecting a Category adds the correct categoryId to the Pending Publish request", async () => {
    const user = userEvent.setup();
    const getSpy = mockLoads();
    render(<ReadyToPublishPage />);
    await screen.findByText("Konica EU Mini");
    getSpy.mockClear();
    await user.selectOptions(await screen.findByDisplayValue("All categories"), "cat-1");
    await waitFor(() => {
      const lastCall = getSpy.mock.calls.filter(([path]) => (path as string).startsWith("/api/products/pending-publish")).at(-1);
      expect(lastCall?.[0]).toContain("categoryId=cat-1");
    });
  });

  it("3. changing the Category resets pagination to page 1", async () => {
    const user = userEvent.setup();
    const getSpy = mockLoads({ items: [item()], total: 21, page: 1, pageSize: 20 });
    render(<ReadyToPublishPage />);
    await screen.findByText("Konica EU Mini");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => {
      const lastCall = getSpy.mock.calls.filter(([path]) => (path as string).startsWith("/api/products/pending-publish")).at(-1);
      expect(lastCall?.[0]).toContain("page=2");
    });
    getSpy.mockClear();
    await user.selectOptions(await screen.findByDisplayValue("All categories"), "cat-2");
    await waitFor(() => {
      const lastCall = getSpy.mock.calls.filter(([path]) => (path as string).startsWith("/api/products/pending-publish")).at(-1);
      expect(lastCall?.[0]).toContain("page=1");
      expect(lastCall?.[0]).toContain("categoryId=cat-2");
    });
  });

  it("4. clearing the Category (back to All categories) removes categoryId from the request", async () => {
    const user = userEvent.setup();
    const getSpy = mockLoads();
    render(<ReadyToPublishPage />);
    await screen.findByText("Konica EU Mini");
    const select = await screen.findByDisplayValue("All categories");
    await user.selectOptions(select, "cat-1");
    await waitFor(() => {
      const lastCall = getSpy.mock.calls.filter(([path]) => (path as string).startsWith("/api/products/pending-publish")).at(-1);
      expect(lastCall?.[0]).toContain("categoryId=cat-1");
    });
    getSpy.mockClear();
    await user.selectOptions(screen.getByDisplayValue("Cameras"), "");
    await waitFor(() => {
      const lastCall = getSpy.mock.calls.filter(([path]) => (path as string).startsWith("/api/products/pending-publish")).at(-1);
      expect(lastCall?.[0]).not.toContain("categoryId");
    });
  });

  it("5. still requests the dedicated Pending Publish endpoint, never the old generic status=approved endpoint", async () => {
    const getSpy = mockLoads();
    render(<ReadyToPublishPage />);
    await screen.findByText("Konica EU Mini");
    const call = getSpy.mock.calls.find(([path]) => (path as string).startsWith("/api/products"));
    expect(call?.[0]).toContain("/api/products/pending-publish");
    expect(call?.[0]).not.toContain("status=approved");
  });

  it("6. the three-column Product Name / Stock Accepted / Action table is unchanged", async () => {
    mockLoads();
    render(<ReadyToPublishPage />);
    expect(await screen.findByText("Product Name")).toBeInTheDocument();
    expect(screen.getByText("Stock Accepted")).toBeInTheDocument();
    expect(screen.getByText("Action")).toBeInTheDocument();
    expect(screen.queryByText("Category")).not.toBeInTheDocument();
    expect(screen.queryByText("SKU")).not.toBeInTheDocument();
  });

  it("7. Sprint 144: the single row action is unchanged in shape (still exactly one navigation link), now targeting canonical Edit", async () => {
    mockLoads();
    render(<ReadyToPublishPage />);
    await screen.findByText("Konica EU Mini");
    expect(screen.getByRole("link", { name: "Edit Product" })).toHaveAttribute("href", "/products/product-1/edit");
    expect(screen.queryByRole("link", { name: "Preview" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Edit / Publish" })).not.toBeInTheDocument();
  });

  it("8. no in-page Publish mutation was restored alongside the Category filter", async () => {
    mockLoads();
    render(<ReadyToPublishPage />);
    await screen.findByText("Konica EU Mini");
    expect(screen.queryByRole("button", { name: /publish/i })).not.toBeInTheDocument();
  });
});
