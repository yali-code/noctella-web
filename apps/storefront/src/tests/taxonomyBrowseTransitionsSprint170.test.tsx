// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CategoryPageClient } from "@/app/category/[slug]/CategoryPageClient";
import { CollectionPageClient } from "@/app/collection/[slug]/CollectionPageClient";
import { api, ApiError } from "@/lib/api";
import { normalizeTaxonomyPage, taxonomyBrowseHref } from "@/lib/taxonomyBrowseParams";
import type { PublicProduct } from "@/lib/types";

const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>{children}</a>
  ),
}));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: { get: vi.fn() },
}));

function product(id: string): PublicProduct {
  return {
    id,
    slug: id,
    title: `Product ${id.toUpperCase()}`,
    type: "unique_item",
    priceEur: 10,
    customsWarning: false,
    isFeatured: false,
    allowMakeOffer: false,
    allowCashOnDelivery: true,
    status: "published",
    images: [],
    createdAt: "",
    updatedAt: "",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const category = (slug: string) => ({ id: `cat-${slug}`, slug, name: `Category ${slug.toUpperCase()}`, description: `Category ${slug} description` });
const collection = (slug: string) => ({ id: `col-${slug}`, slug, name: `Collection ${slug.toUpperCase()}`, description: `Collection ${slug} description`, coverImageUrl: `/${slug}.webp` });
const pageResult = (id: string, total = 24) => ({ items: [product(id)], total, page: 1, pageSize: 12 });

describe("Sprint 170 taxonomy browse parameters", () => {
  it.each([
    [undefined, 1],
    ["1", 1],
    ["2", 2],
    ["0", 1],
    ["-2", 1],
    ["1.5", 1],
    ["nope", 1],
    [["3", "7"], 3],
    [["bad", "4"], 1],
    ["10001", 1],
    ["9007199254740992", 1],
  ])("normalizes %j to %d", (value, expected) => {
    expect(normalizeTaxonomyPage(value)).toBe(expected);
  });

  it("generates canonical category and collection page URLs", () => {
    expect(taxonomyBrowseHref("category", "cameras", 1)).toBe("/category/cameras");
    expect(taxonomyBrowseHref("category", "cameras", 2)).toBe("/category/cameras?page=2");
    expect(taxonomyBrowseHref("collection", "icons", 1)).toBe("/collection/icons");
    expect(taxonomyBrowseHref("collection", "icons", 3)).toBe("/collection/icons?page=3");
  });
});

describe("Sprint 170 taxonomy browse transitions", () => {
  beforeEach(() => {
    navigation.push.mockReset();
    navigation.replace.mockReset();
    vi.mocked(api.get).mockReset();
    localStorage.clear();
  });
  afterEach(cleanup);

  it.each([
    ["category", CategoryPageClient],
    ["collection", CollectionPageClient],
  ] as const)("uses the URL-derived page and navigates canonically for %s", async (kind, Client) => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path.includes("/products?")) return pageResult("current", 36) as never;
      return (kind === "category" ? category("alpha") : collection("alpha")) as never;
    });
    render(<Client slug="alpha" page={2} />);
    await screen.findByText("Page 2 of 3 (36 items)");
    expect(vi.mocked(api.get).mock.calls.some(([path]) => String(path).includes("page=2"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(navigation.push).toHaveBeenCalledWith(`/${kind}/alpha`);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(navigation.push).toHaveBeenCalledWith(`/${kind}/alpha?page=3`);
  });

  it("follows a history-style page prop change instead of retaining local page memory", async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path.includes("/products?")) return pageResult(path.includes("page=3") ? "third" : "second", 48) as never;
      return category("alpha") as never;
    });
    const view = render(<CategoryPageClient slug="alpha" page={2} />);
    expect(await screen.findByRole("heading", { name: "Product SECOND" })).toBeTruthy();
    view.rerender(<CategoryPageClient slug="alpha" page={3} />);
    expect(screen.queryByRole("heading", { name: "Product SECOND" })).toBeNull();
    expect(await screen.findByRole("heading", { name: "Product THIRD" })).toBeTruthy();
    expect(screen.getByText("Page 3 of 4 (48 items)")).toBeTruthy();
  });

  it("immediately suppresses fully resolved category content while the destination is pending", async () => {
    const nextTaxonomy = deferred<ReturnType<typeof category>>();
    const nextProducts = deferred<ReturnType<typeof pageResult>>();
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path.includes("/products?") && path.includes("categorySlug=old")) return Promise.resolve(pageResult("old", 36)) as never;
      if (path.includes("/products?")) return nextProducts.promise as never;
      if (path.endsWith("/old")) return Promise.resolve(category("old")) as never;
      return nextTaxonomy.promise as never;
    });
    const view = render(<CategoryPageClient slug="old" page={2} />);
    expect(await screen.findByRole("heading", { name: "Category OLD" })).toBeTruthy();
    expect(screen.getByText("Category old description")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Product OLD" })).toBeTruthy();
    expect(screen.getByText("Page 2 of 3 (36 items)")).toBeTruthy();

    view.rerender(<CategoryPageClient slug="new" page={1} />);
    expect(screen.queryByRole("heading", { name: "Category OLD" })).toBeNull();
    expect(screen.queryByText("Category old description")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Product OLD" })).toBeNull();
    expect(screen.queryByText("Page 2 of 3 (36 items)")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Loading...");

    nextTaxonomy.resolve(category("new"));
    nextProducts.resolve(pageResult("new"));
    expect(await screen.findByRole("heading", { name: "Category NEW" })).toBeTruthy();
    expect(screen.getByText("Category new description")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Product NEW" })).toBeTruthy();
    expect(screen.queryByText(/OLD/)).toBeNull();
  });

  it("immediately suppresses fully resolved collection content and cover while the destination is pending", async () => {
    const nextTaxonomy = deferred<ReturnType<typeof collection>>();
    const nextProducts = deferred<ReturnType<typeof pageResult>>();
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path.includes("/products?") && path.includes("collectionSlug=old")) return Promise.resolve(pageResult("old", 36)) as never;
      if (path.includes("/products?")) return nextProducts.promise as never;
      if (path.endsWith("/old")) return Promise.resolve(collection("old")) as never;
      return nextTaxonomy.promise as never;
    });
    const view = render(<CollectionPageClient slug="old" page={2} />);
    expect(await screen.findByRole("heading", { name: "Collection OLD" })).toBeTruthy();
    expect(screen.getByText("Collection old description")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Collection OLD" }).getAttribute("src")).toBe("/old.webp");
    expect(await screen.findByRole("heading", { name: "Product OLD" })).toBeTruthy();
    expect(screen.getByText("Page 2 of 3 (36 items)")).toBeTruthy();

    view.rerender(<CollectionPageClient slug="new" page={1} />);
    expect(screen.queryByRole("heading", { name: "Collection OLD" })).toBeNull();
    expect(screen.queryByText("Collection old description")).toBeNull();
    expect(screen.queryByRole("img", { name: "Collection OLD" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Product OLD" })).toBeNull();
    expect(screen.queryByText("Page 2 of 3 (36 items)")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Loading...");

    nextTaxonomy.resolve(collection("new"));
    nextProducts.resolve(pageResult("new"));
    expect(await screen.findByRole("heading", { name: "Collection NEW" })).toBeTruthy();
    expect(screen.getByText("Collection new description")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Collection NEW" }).getAttribute("src")).toBe("/new.webp");
    expect(await screen.findByRole("heading", { name: "Product NEW" })).toBeTruthy();
    expect(screen.queryByText(/OLD/)).toBeNull();
  });

  it.each([
    ["category", CategoryPageClient],
    ["collection", CollectionPageClient],
  ] as const)("hides old %s identity and ignores its obsolete taxonomy success", async (kind, Client) => {
    const oldTaxonomy = deferred<ReturnType<typeof category>>();
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path.includes("/products?")) return Promise.resolve(pageResult(path.includes("Slug=old") ? "old" : "new")) as never;
      if (path.endsWith("/old")) return oldTaxonomy.promise as never;
      return Promise.resolve(kind === "category" ? category("new") : collection("new")) as never;
    });
    const view = render(<Client slug="old" page={4} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    view.rerender(<Client slug="new" page={1} />);
    expect(screen.queryByText(/OLD/)).toBeNull();
    expect(await screen.findByRole("heading", { name: `${kind === "category" ? "Category" : "Collection"} NEW` })).toBeTruthy();
    oldTaxonomy.resolve(category("old"));
    await waitFor(() => expect(screen.queryByText(`${kind === "category" ? "Category" : "Collection"} OLD`)).toBeNull());
    expect(vi.mocked(api.get).mock.calls.some(([path]) => String(path).includes("page=1") && String(path).includes("Slug=new"))).toBe(true);
  });

  it("keeps the latest products, total, and loading ownership when an older request finishes", async () => {
    const older = deferred<ReturnType<typeof pageResult>>();
    const latest = deferred<ReturnType<typeof pageResult>>();
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (!path.includes("/products?")) return Promise.resolve(category("alpha")) as never;
      return (path.includes("page=1") ? older.promise : latest.promise) as never;
    });
    const view = render(<CategoryPageClient slug="alpha" page={1} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    view.rerender(<CategoryPageClient slug="alpha" page={2} />);
    older.resolve(pageResult("old", 12));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Loading..."));
    expect(screen.queryByRole("heading", { name: "Product OLD" })).toBeNull();
    latest.resolve(pageResult("new", 36));
    expect(await screen.findByRole("heading", { name: "Product NEW" })).toBeTruthy();
    expect(screen.getByText("Page 2 of 3 (36 items)")).toBeTruthy();
  });

  it.each([
    ["404", new ApiError("missing", 404)],
    ["general failure", new Error("network")],
  ])("ignores an obsolete taxonomy %s after a newer category succeeds", async (_label, failure) => {
    const older = deferred<ReturnType<typeof category>>();
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path.includes("/products?")) return Promise.resolve(pageResult("current")) as never;
      if (path.endsWith("/old")) return older.promise as never;
      return Promise.resolve(category("new")) as never;
    });
    const view = render(<CategoryPageClient slug="old" page={1} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    view.rerender(<CategoryPageClient slug="new" page={1} />);
    expect(await screen.findByRole("heading", { name: "Category NEW" })).toBeTruthy();
    older.reject(failure);
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Category not found" })).toBeNull());
    expect(screen.getByRole("heading", { name: "Category NEW" })).toBeTruthy();
  });

  it("ignores an obsolete product failure after a newer collection succeeds", async () => {
    const older = deferred<ReturnType<typeof pageResult>>();
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (!path.includes("/products?")) return Promise.resolve(collection(path.endsWith("/old") ? "old" : "new")) as never;
      if (path.includes("Slug=old")) return older.promise as never;
      return Promise.resolve(pageResult("new")) as never;
    });
    const view = render(<CollectionPageClient slug="old" page={1} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    view.rerender(<CollectionPageClient slug="new" page={1} />);
    expect(await screen.findByRole("heading", { name: "Product NEW" })).toBeTruthy();
    older.reject(new Error("obsolete"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByRole("heading", { name: "Product NEW" })).toBeTruthy();
  });

  it.each([
    ["category", CategoryPageClient, "Category not found"],
    ["collection", CollectionPageClient, "Collection not found"],
  ] as const)("renders and recovers from a current %s 404", async (kind, Client, message) => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path.includes("/products?")) return pageResult("valid") as never;
      if (path.endsWith("/missing")) throw new ApiError("missing", 404);
      return (kind === "category" ? category("valid") : collection("valid")) as never;
    });
    const view = render(<Client slug="missing" page={1} />);
    expect(await screen.findByRole("heading", { name: message })).toBeTruthy();
    view.rerender(<Client slug="valid" page={1} />);
    expect(await screen.findByRole("heading", { name: `${kind === "category" ? "Category" : "Collection"} VALID` })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: message })).toBeNull();
  });

  it("renders a current product failure and recovers on a valid destination", async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (!path.includes("/products?")) return category(path.endsWith("/bad") ? "bad" : "good") as never;
      if (path.includes("Slug=bad")) throw new Error("network");
      return pageResult("good") as never;
    });
    const view = render(<CategoryPageClient slug="bad" page={1} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Something went wrong loading products");
    view.rerender(<CategoryPageClient slug="good" page={1} />);
    expect(await screen.findByRole("heading", { name: "Product GOOD" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    ["category", CategoryPageClient],
    ["collection", CollectionPageClient],
  ] as const)("replaces an out-of-range %s page with its last canonical page", async (kind, Client) => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path.includes("/products?")) return { items: [], total: 25, page: 9, pageSize: 12 } as never;
      return (kind === "category" ? category("alpha") : collection("alpha")) as never;
    });
    render(<Client slug="alpha" page={9} />);
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith(`/${kind}/alpha?page=3`));
    expect(navigation.replace).toHaveBeenCalledTimes(1);
  });

  it("canonicalizes an empty result to page one and ignores completions after unmount", async () => {
    const taxonomy = deferred<ReturnType<typeof category>>();
    const products = deferred<ReturnType<typeof pageResult>>();
    vi.mocked(api.get).mockImplementation((path: string) => path.includes("/products?") ? products.promise as never : taxonomy.promise as never);
    const view = render(<CategoryPageClient slug="alpha" page={4} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    view.unmount();
    taxonomy.resolve(category("alpha"));
    products.resolve({ items: [], total: 0, page: 4, pageSize: 12 });
    await Promise.resolve();
    expect(navigation.replace).not.toHaveBeenCalled();

    vi.mocked(api.get).mockImplementation(async (path: string) => path.includes("/products?")
      ? { items: [], total: 0, page: 4, pageSize: 12 } as never
      : category("alpha") as never);
    render(<CategoryPageClient slug="alpha" page={4} />);
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/category/alpha"));
  });
});
