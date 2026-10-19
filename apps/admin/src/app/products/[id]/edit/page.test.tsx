// @vitest-environment jsdom
// Sprint 88 (ADR-017): proves EditProductPage owns the version token separately from
// ProductFormValues - initialized from GET's Product.updatedAt, forwarded as expectedUpdatedAt on
// PUT, replaced with the successful response's updatedAt (enabling a second save with the fresh
// token), left unchanged on a version conflict (no router.push in that case), and that the
// explicit reload action performs only the approved reload.
// Sprint 147: a successful generic Save now navigates to /ready-to-publish (was /products/:id);
// Save-before-Publish (a separate onSaveForPublish callback) never navigates at all. A resolved
// Publish Selected batch - regardless of per-channel outcome - navigates to /products only after
// the existing canonical Product refetch; a request-level batch rejection never navigates.
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/api";
import * as apiLib from "@/lib/api";
import * as marketplacesLib from "@/lib/marketplaces";
import{productLifecycleApi}from"@/lib/productLifecycle";import{ProductStatus}from"@noctella/shared";
import EditProductPage from "./page";

afterEach(() => {
  vi.restoreAllMocks();
  // push is a plain vi.fn() referenced by the module-level next/navigation mock, not a spy on an
  // existing object - restoreAllMocks() does not clear its call history between tests.
  push.mockClear();
});

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

/**
 * ProductForm also fetches /api/categories and /api/collections on mount - a blanket
 * mockResolvedValue on api.get would resolve those with the Product object too, and
 * `res.items` being undefined then crashes the categories.map() render. Route by path instead.
 *
 * Sprint 144: EditProductPage now supplies `productId` to ProductForm, which mounts the Marketing
 * Tags section and calls marketingTagsApi.list() (GET .../marketing-tags) - that endpoint returns
 * a bare `MarketingTag[]`, not a `{ items: [] }` paginated envelope, so it must be routed
 * separately from the categories/collections fallback below.
 *
 * Sprint 146: ProductForm also mounts PublishActions, which calls publishingApi.getPreview (GET
 * .../publish?channel=X) and marketplaceApi.listConnections (GET /api/marketplaces/connections) -
 * neither returns a `{ items: [] }` paginated envelope either (a PublishPreview object and a bare
 * MarketplaceConnection[] respectively), so both must be routed to safe, minimally-valid defaults
 * too, or PublishActions' own render would throw reading `.validation.valid` off `{ items: [] }`.
 */
function mockGetForProduct(product: any) {
  return vi.spyOn(apiLib.api, "get").mockImplementation(async (path: string) => {
    if (path === `/api/products/${product.id}`) return product;
    if (path === `/api/products/${product.id}/marketing-tags`) return [];
    if (path.startsWith(`/api/products/${product.id}/publish?channel=`)) {
      return { productId: product.id, channel: "ebay", validation: { productId: product.id, channel: "ebay", valid: false, errors: [], warnings: [] } };
    }
    if (path === "/api/marketplaces/connections") return [];
    return { items: [] };
  });
}

function baseProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    sku: "SKU-1",
    title: "Original Title",
    slug: "original-title",
    type: "unique",
    status: "draft",
    categoryId: "cat-1",
    customsWarning: false,
    isFeatured: false,
    allowMakeOffer: false,
    allowCashOnDelivery: false,
    showInArchiveAfterSale: false,
    priceEur: 100,
    images: [],
    photos: [],
    marketplaceReadiness: { ebay: { ready: false, missingFields: [] }, etsy: { ready: false, missingFields: [] }, woocommerce: { ready: false, missingFields: [] } },
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as any;
}

describe("EditProductPage — Sprint 88 version-token ownership", () => {
  it.each([{before:"2026-01-01T00:00:00.000Z",after:"V2",expected:"V2",conflict:false},{before:"V2",after:"V3",expected:"2026-01-01T00:00:00.000Z",conflict:true}])("keeps Pause token rule for later Save",async({before,after,expected,conflict})=>{const user=userEvent.setup();mockGetForProduct(baseProduct());vi.spyOn(productLifecycleApi,"archiveSafety").mockResolvedValue({canArchive:true});vi.spyOn(productLifecycleApi,"state").mockResolvedValue({productId:"p1",productStatus:ProductStatus.Draft,productUpdatedAt:after,hasActiveExternalListings:false});vi.spyOn(productLifecycleApi,"pause").mockResolvedValue({operation:{id:"o",productId:"p1",action:"pause",status:"succeeded",previousProductStatus:ProductStatus.Draft,targetSnapshot:[],targetResults:[],actorAdminUserId:"a",idempotencyKey:"k",createdAt:"t",updatedAt:"t"},productUpdatedAtBefore:before,productUpdatedAtAfter:after});const put=vi.spyOn(apiLib.api,"put");conflict?put.mockRejectedValue(new ApiError("Conflict",409,undefined,"PRODUCT_VERSION_CONFLICT")):put.mockResolvedValue(baseProduct({updatedAt:after}));render(<EditProductPage params={{id:"p1"}}/>);const title=await screen.findByDisplayValue("Original Title");await user.clear(title);await user.type(title,"Unsaved");await user.click(await screen.findByRole("button",{name:"Pause"}));await user.click(screen.getByRole("button",{name:"Pause Now"}));await user.click(screen.getByRole("button",{name:"Save Changes"}));await waitFor(()=>expect(put).toHaveBeenCalledWith("/api/products/p1",expect.objectContaining({expectedUpdatedAt:expected,title:"Unsaved"})));if(conflict){expect(await screen.findByRole("button",{name:"Reload Latest Product"})).toBeInTheDocument();expect(screen.getByDisplayValue("Unsaved")).toBeInTheDocument();expect(push).not.toHaveBeenCalled()}});
  it("initializes the token from GET, forwards it on PUT, replaces it on success, and a second save uses the new token", async () => {
    const user = userEvent.setup();
    const product = baseProduct();
    const getSpy = mockGetForProduct(product);
    const putSpy = vi
      .spyOn(apiLib.api, "put")
      .mockResolvedValueOnce(baseProduct({ title: "Saved Once", updatedAt: "2026-01-02T00:00:00.000Z" }))
      .mockResolvedValueOnce(baseProduct({ title: "Saved Twice", updatedAt: "2026-01-03T00:00:00.000Z" }));

    render(<EditProductPage params={{ id: "p1" }} />);
    await screen.findByDisplayValue("Original Title");
    expect(getSpy).toHaveBeenCalledWith("/api/products/p1");

    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(1));
    expect(putSpy).toHaveBeenNthCalledWith(1, "/api/products/p1", expect.objectContaining({ expectedUpdatedAt: "2026-01-01T00:00:00.000Z" }));
    // Sprint 147: a successful generic Save now returns to the Pending Publish queue, not Product Detail.
    await waitFor(() => expect(push).toHaveBeenCalledWith("/ready-to-publish"));

    // Second save (component stays mounted) must use the token from the first successful response.
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(2));
    expect(putSpy).toHaveBeenNthCalledWith(2, "/api/products/p1", expect.objectContaining({ expectedUpdatedAt: "2026-01-02T00:00:00.000Z" }));
  });

  it("leaves the token unchanged and does not navigate on a version conflict", async () => {
    const user = userEvent.setup();
    const product = baseProduct();
    mockGetForProduct(product);
    const putSpy = vi.spyOn(apiLib.api, "put").mockRejectedValue(
      new ApiError("This product changed after you opened it. Reload the latest version before saving again.", 409, undefined, "PRODUCT_VERSION_CONFLICT", {
        productId: "p1",
        expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
        currentUpdatedAt: "2026-01-05T00:00:00.000Z",
      }),
    );

    render(<EditProductPage params={{ id: "p1" }} />);
    await screen.findByDisplayValue("Original Title");

    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(1));
    await screen.findByRole("button", { name: "Reload Latest Product" });
    expect(push).not.toHaveBeenCalled();

    // A retried save must still use the original (unchanged) token, not something derived from the conflict.
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(2));
    expect(putSpy).toHaveBeenNthCalledWith(2, "/api/products/p1", expect.objectContaining({ expectedUpdatedAt: "2026-01-01T00:00:00.000Z" }));
  });

  it("clicking the explicit reload action performs only the approved reload, not an automatic one", async () => {
    const user = userEvent.setup();
    const product = baseProduct();
    mockGetForProduct(product);
    vi.spyOn(apiLib.api, "put").mockRejectedValue(
      new ApiError("Reload required", 409, undefined, "PRODUCT_VERSION_CONFLICT", { productId: "p1", expectedUpdatedAt: "old", currentUpdatedAt: "new" }),
    );
    const reload = vi.fn();
    Object.defineProperty(window, "location", { value: { ...window.location, reload }, writable: true });

    render(<EditProductPage params={{ id: "p1" }} />);
    await screen.findByDisplayValue("Original Title");

    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    const reloadButton = await screen.findByRole("button", { name: "Reload Latest Product" });
    expect(reload).not.toHaveBeenCalled();

    await user.click(reloadButton);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("Sprint 147: an ordinary (non-conflict) Save failure does not navigate", async () => {
    const user = userEvent.setup();
    const product = baseProduct();
    mockGetForProduct(product);
    vi.spyOn(apiLib.api, "put").mockRejectedValue(new ApiError("Validation failed", 400, [{ path: "title", message: "Title is required" }]));

    render(<EditProductPage params={{ id: "p1" }} />);
    await screen.findByDisplayValue("Original Title");

    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await screen.findByText("Title is required");
    expect(push).not.toHaveBeenCalled();
  });
});

/**
 * Sprint 147: end-to-end proof that the full EditProductPage -> ProductForm -> PublishActions
 * composition is wired correctly - the onPublishComplete callback (supplied only here, at
 * EditProductPage) actually reaches PublishActions and actually triggers router.push("/products")
 * at the right moment, regardless of the resolved batch's per-channel outcome, and never fires on
 * a request-level rejection. Component-level state-machine/call-order proofs for PublishActions
 * itself (in isolation, with mock props) live in PublishActions.test.tsx; this file only proves
 * the real composition/callback wiring end-to-end.
 */
describe("EditProductPage — Sprint 147: Publish Selected navigation (end-to-end)", () => {
  it("a resolved batch (Noctella Web succeeded) navigates to /products only after the canonical Product refetch", async () => {
    const user = userEvent.setup();
    const product = baseProduct();
    const getSpy = mockGetForProduct(product);
    const batchSpy = vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch").mockResolvedValue({
      productId: "p1",
      results: [{ channel: "noctella_web", outcome: "succeeded", result: {} as any }],
    } as any);

    render(<EditProductPage params={{ id: "p1" }} />);
    await screen.findByDisplayValue("Original Title");

    await user.click(screen.getByRole("checkbox", { name: "Noctella Web" }));
    await user.click(screen.getByRole("button", { name: "Publish Selected" }));

    await waitFor(() => expect(batchSpy).toHaveBeenCalled());
    await waitFor(() => expect(push).toHaveBeenCalledWith("/products"));
    // The canonical Product refetch (a second GET for the same Product) happened before navigation.
    const productGetCalls = getSpy.mock.calls.filter(([path]) => path === "/api/products/p1");
    expect(productGetCalls.length).toBeGreaterThanOrEqual(2); // initial page load + post-publish refetch
  });

  it("a completed batch where all selected channels return normal failed results still navigates to /products", async () => {
    const user = userEvent.setup();
    const product = baseProduct();
    mockGetForProduct(product);
    vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch").mockResolvedValue({
      productId: "p1",
      results: [{ channel: "ebay", outcome: "failed", error: { message: "Marketplace connection is not connected" } }],
    } as any);

    render(<EditProductPage params={{ id: "p1" }} />);
    await screen.findByDisplayValue("Original Title");

    await user.click(screen.getByRole("checkbox", { name: "eBay" }));
    await user.click(screen.getByRole("button", { name: "Publish Selected" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/products"));
  });

  it("a request-level executePublishBatch rejection (e.g. PRODUCT_VERSION_CONFLICT) never navigates - stays on Edit with the error visible", async () => {
    const user = userEvent.setup();
    const product = baseProduct();
    mockGetForProduct(product);
    vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch").mockRejectedValue(
      new ApiError("This product changed after you opened it. Reload the latest version before saving again.", 409, undefined, "PRODUCT_VERSION_CONFLICT"),
    );

    render(<EditProductPage params={{ id: "p1" }} />);
    await screen.findByDisplayValue("Original Title");

    await user.click(screen.getByRole("checkbox", { name: "eBay" }));
    await user.click(screen.getByRole("button", { name: "Publish Selected" }));

    await screen.findByText("This product changed after you opened it. Reload the latest version before saving again.");
    expect(push).not.toHaveBeenCalled();
  });
});

describe("EditProductPage — Etsy media preview integration", () => {
  it("uses the existing canonical product read, not legacy images or unsaved title fields", async () => {
    const user = userEvent.setup();
    const product = baseProduct({ photos: [{ id: "photo", url: "/canonical.webp", thumbnailUrl: "", sortOrder: 0, isPrimary: true, processingStatus: "Ready", altText: "Canonical image" }], images: [{ url: "/legacy.webp", isPrimary: true }] });
    const get = mockGetForProduct(product);
    const put = vi.spyOn(apiLib.api, "put");
    render(<EditProductPage params={{ id: "p1" }} />);
    const title = await screen.findByDisplayValue("Original Title");
    const preview = screen.getByRole("region", { name: "Etsy Media Preview" });
    expect(within(preview).getByRole("img", { name: "Canonical image" })).toHaveAttribute("src", apiLib.resolveApiAssetUrl("/canonical.webp"));
    expect(preview.innerHTML).not.toContain("legacy.webp");
    await user.clear(title); await user.type(title, "Unsaved title");
    expect(within(preview).getByRole("img")).toHaveAttribute("alt", "Canonical image");
    expect(get.mock.calls.filter(([path]) => path === "/api/products/p1")).toHaveLength(1);
    expect(put).not.toHaveBeenCalled();
    expect(preview).toHaveTextContent("not published or synced to Etsy");
    expect(preview).not.toHaveTextContent("Ready to Publish");
  });

  it("provides an accessible preview loading and failed-read state", async () => {
    vi.spyOn(apiLib.api, "get").mockRejectedValue(new Error("Product read failed"));
    render(<EditProductPage params={{ id: "p1" }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading Etsy media preview");
    const preview = screen.getByRole("region", { name: "Etsy Media Preview" });
    expect(await screen.findByRole("alert")).toHaveTextContent("preview unavailable");
    expect(within(preview).queryByRole("img")).not.toBeInTheDocument();
  });
});

describe("EditProductPage — combined Phase 1 listing and Phase 2 media", () => {
  it("loads persisted Etsy fields beside canonical media and saves them with the existing version contract", async () => {
    const user = userEvent.setup();
    const product = baseProduct({ type: "lot_item", stockQuantity: 3, etsyTaxonomyId: "1234", etsyQuantity: 2, etsyShippingProfileId: "111",
      etsyReturnPolicyId: "222", etsyWhoMade: "someone_else", etsyWhenMade: "1970s", etsyVintageYear: 1972,
      etsyTitle: "Vintage camera", etsyListingPriceEur: 120, etsyGpsrManufacturerName: "Seller manufacturer",
      etsyGpsrManufacturerContact: "seller@example.test", etsyAdsOptIn: false,
      photos: [{ id: "photo", url: "/ready.webp", thumbnailUrl: "", sortOrder: 0, isPrimary: true, processingStatus: "Ready", altText: "Seller photo" }] });
    mockGetForProduct(product);
    const put = vi.spyOn(apiLib.api, "put").mockResolvedValue({ ...product, updatedAt: "2026-01-02T00:00:00.000Z" });
    const publish = vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch");
    render(<EditProductPage params={{ id: "p1" }} />);
    expect(await screen.findByLabelText("Etsy category (taxonomy ID) *")).toHaveValue("1234");
    expect(screen.getByLabelText("Etsy quantity (blank = ERP stock; never above ERP stock)")).toHaveValue("2");
    expect(screen.getByLabelText("Etsy shipping profile ID *")).toHaveValue("111");
    expect(screen.getByLabelText("Manufacturer name")).toHaveValue("Seller manufacturer");
    expect(screen.getByRole("checkbox", { name: /Etsy Ads preference/ })).not.toBeChecked();
    const preview = screen.getByRole("region", { name: "Etsy Media Preview" });
    expect(within(preview).getByRole("img", { name: "Seller photo" })).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Etsy category (taxonomy ID) *"));
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(put).toHaveBeenCalledWith("/api/products/p1", expect.objectContaining({
      expectedUpdatedAt: product.updatedAt, etsyTaxonomyId: null, etsyQuantity: 2, etsyListingPriceEur: 120,
      etsyGpsrManufacturerName: "Seller manufacturer", etsyAdsOptIn: false,
    })));
    expect(publish).not.toHaveBeenCalled();
    expect(preview).toHaveTextContent("Media eligibility only");
  });

  it("keeps unsaved Etsy values and read-only media after a version conflict, without publishing", async () => {
    const user = userEvent.setup();
    mockGetForProduct(baseProduct({ photos: [] }));
    const put = vi.spyOn(apiLib.api, "put").mockRejectedValue(new ApiError("Reload latest product", 409, undefined, "PRODUCT_VERSION_CONFLICT"));
    const publish = vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch");
    render(<EditProductPage params={{ id: "p1" }} />);
    await user.type(await screen.findByLabelText("Etsy category (taxonomy ID) *"), "1234");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await screen.findByRole("button", { name: "Reload Latest Product" });
    expect(screen.getByLabelText("Etsy category (taxonomy ID) *")).toHaveValue("1234");
    expect(put).toHaveBeenCalledWith("/api/products/p1", expect.objectContaining({ expectedUpdatedAt: "2026-01-01T00:00:00.000Z", etsyTaxonomyId: "1234" }));
    expect(push).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
    expect(within(screen.getByRole("region", { name: "Etsy Media Preview" })).getByRole("status")).toHaveTextContent("needs attention");
  });
});
