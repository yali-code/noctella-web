// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ApiError, api } from "@/lib/api";
import ProductLabelPage from "./page";

const barcodeCalls: unknown[][] = [];
vi.mock("jsbarcode", () => ({
  default: (...args: unknown[]) => {
    barcodeCalls.push(args);
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  barcodeCalls.length = 0;
});

function product(overrides: Record<string, unknown> = {}) {
  return {
    id: "product-9",
    sku: "NOC-000123",
    title: "Canon Camera",
    categoryId: "cat-1",
    status: "draft",
    stockQuantity: 1,
    photos: [],
    images: [],
    marketplaceReadiness: {},
    createdAt: "t",
    updatedAt: "t",
    ...overrides,
  };
}

const categoriesResponse = {
  items: [{ id: "cat-1", name: "Camera", displayOrder: 0, isActive: true, createdAt: "t", updatedAt: "t" }],
  total: 1,
  page: 1,
  pageSize: 100,
};

function mockLoads(productResult: Record<string, unknown> = product(), categoriesResult: Record<string, unknown> = categoriesResponse) {
  return vi.spyOn(api, "get").mockImplementation((path: string) => {
    if (path.startsWith("/api/categories")) return Promise.resolve(categoriesResult) as any;
    if (path === "/api/products/product-9") return Promise.resolve(productResult) as any;
    return Promise.reject(new Error(`Unexpected path: ${path}`));
  });
}

function categoriesWithSlug(slug: string) {
  return {
    items: [{ id: "cat-1", name: "Camera", slug, displayOrder: 0, isActive: true, createdAt: "t", updatedAt: "t" }],
    total: 1,
    page: 1,
    pageSize: 100,
  };
}

describe("Product Stock Label page (Sprint 137)", () => {
  it("fetches fresh authoritative Product data from GET /api/products/:id - never trusts stale local state", async () => {
    const getSpy = mockLoads();
    render(<ProductLabelPage params={{ id: "product-9" }} />);
    await screen.findByText("Canon Camera");
    expect(getSpy).toHaveBeenCalledWith("/api/products/product-9");
  });

  it("displays title, quantity, and category", async () => {
    mockLoads(product({ stockQuantity: 1 }));
    render(<ProductLabelPage params={{ id: "product-9" }} />);
    expect(await screen.findByText("Canon Camera")).toBeInTheDocument();
    expect(screen.getByText(/1 item/)).toBeInTheDocument();
    expect(screen.getByText(/· Camera/)).toBeInTheDocument();
  });

  it("pluralizes the quantity label for more than one item", async () => {
    mockLoads(product({ stockQuantity: 3 }));
    render(<ProductLabelPage params={{ id: "product-9" }} />);
    expect(await screen.findByText(/3 items/)).toBeInTheDocument();
  });

  it("displays the human-readable SKU as plain text", async () => {
    mockLoads();
    render(<ProductLabelPage params={{ id: "product-9" }} />);
    expect(await screen.findByText("NOC-000123")).toBeInTheDocument();
  });

  it("renders the barcode with EXACTLY product.sku as the payload - never a second identifier, never price, never a UUID", async () => {
    mockLoads();
    render(<ProductLabelPage params={{ id: "product-9" }} />);
    await screen.findByText("Canon Camera");
    await waitFor(() => expect(barcodeCalls).toHaveLength(1));
    const [, data, options] = barcodeCalls[0] as [unknown, string, Record<string, unknown>];
    expect(data).toBe("NOC-000123");
    expect(options).toMatchObject({ format: "CODE128" });
  });

  it("the Print action is disabled until the barcode has actually rendered, and never calls window.print() before that", async () => {
    mockLoads();
    const printSpy = vi.spyOn(window, "print").mockImplementation(() => {});
    render(<ProductLabelPage params={{ id: "product-9" }} />);
    await screen.findByText("Canon Camera");
    const printButton = await screen.findByRole("button", { name: "Print Barcode" });
    await waitFor(() => expect(printButton).not.toBeDisabled());
    expect(printSpy).not.toHaveBeenCalled();
  });

  it("renders an error state when the Product cannot be loaded, without crashing", async () => {
    vi.spyOn(api, "get").mockRejectedValue(new ApiError("Product not found", 404));
    render(<ProductLabelPage params={{ id: "missing" }} />);
    expect(await screen.findByText("Product not found")).toBeInTheDocument();
  });
});

describe("Product Stock Label page: display-only category code (Sprint 138)", () => {
  it("cameras-optics -> CAM · <SKU>, never a second SKU or CAM-<SKU> identity", async () => {
    mockLoads(product(), categoriesWithSlug("cameras-optics"));
    render(<ProductLabelPage params={{ id: "product-9" }} />);
    expect(await screen.findByText("CAM · NOC-000123")).toBeInTheDocument();
    expect(screen.queryByText("CAM-NOC-000123")).not.toBeInTheDocument();
  });

  it("watches-timepieces -> WAT · <SKU>", async () => {
    mockLoads(product(), categoriesWithSlug("watches-timepieces"));
    render(<ProductLabelPage params={{ id: "product-9" }} />);
    expect(await screen.findByText("WAT · NOC-000123")).toBeInTheDocument();
  });

  it("home-decor -> HDEC · <SKU>", async () => {
    mockLoads(product(), categoriesWithSlug("home-decor"));
    render(<ProductLabelPage params={{ id: "product-9" }} />);
    expect(await screen.findByText("HDEC · NOC-000123")).toBeInTheDocument();
  });

  it("an unknown/new category slug still derives a deterministic code, never a fabricated placeholder", async () => {
    mockLoads(product(), categoriesWithSlug("vintage-typewriters"));
    render(<ProductLabelPage params={{ id: "product-9" }} />);
    expect(await screen.findByText("VIN · NOC-000123")).toBeInTheDocument();
  });

  it("an unresolved Category (no slug available) renders the canonical SKU alone - never a fabricated code", async () => {
    mockLoads(product(), { items: [], total: 0, page: 1, pageSize: 100 });
    render(<ProductLabelPage params={{ id: "product-9" }} />);
    expect(await screen.findByText("NOC-000123")).toBeInTheDocument();
    expect(screen.queryByText(/·\s*NOC-000123/)).not.toBeInTheDocument();
  });

  it("the Code128 barcode still receives EXACTLY product.sku, never the category code or a combined identifier", async () => {
    mockLoads(product(), categoriesWithSlug("cameras-optics"));
    render(<ProductLabelPage params={{ id: "product-9" }} />);
    await screen.findByText("CAM · NOC-000123");
    await waitFor(() => expect(barcodeCalls).toHaveLength(1));
    const [, data] = barcodeCalls[0] as [unknown, string, Record<string, unknown>];
    expect(data).toBe("NOC-000123");
  });
});
