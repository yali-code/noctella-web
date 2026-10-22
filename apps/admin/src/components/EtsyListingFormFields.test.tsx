// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ApiError } from "@/lib/api";
import * as publishingLib from "@/lib/publishing";
import * as marketplacesLib from "@/lib/marketplaces";
import * as canonicalProductProposalsLib from "@/lib/canonicalProductProposals";
import { EtsyListingFormFields, etsyFieldMessages, etsyFormValuesFromProduct, etsyLimitMessage, etsyPayloadFromValues, type EtsyListingFormValues } from "./EtsyListingFormFields";
import { ProductForm, emptyProductForm, productToFormValues } from "./ProductForm";

afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  vi.spyOn(publishingLib.marketplacePreparationApi, "get").mockRejectedValue(new ApiError("Marketplace preparation not found", 404));
  vi.spyOn(canonicalProductProposalsLib.canonicalProductProposalApi, "get").mockRejectedValue(new ApiError("Canonical product AI proposal not found", 404));
  vi.spyOn(publishingLib.publishingApi, "getPreview").mockRejectedValue(new Error("not mocked in this test"));
  vi.spyOn(marketplacesLib.marketplaceApi, "listConnections").mockResolvedValue([]);
});

const saved = {
  etsyTaxonomyId: "1234", etsyShopSectionId: "5678", etsyQuantity: 1, etsySku: "NOC-1", etsyWhoMade: "someone_else", etsyIsSupply: false,
  etsyWhenMade: "1970s", etsyVintageYear: 1972, etsyShippingProfileId: "1111", etsyProcessingProfileId: "2222", etsyReturnPolicyId: "3333",
  etsyRenewalOption: "manual", etsyFeatured: true, etsyAdsOptIn: false, etsyRestockRequests: undefined,
  etsyGpsrManufacturerName: "Example Ltd", etsyGpsrManufacturerAddress: "1 Example St", etsyGpsrManufacturerContact: "safety@example.test",
} as const;

describe("Etsy listing form value mapping", () => {
  it("round-trips saved values and sends typed payload values", () => {
    const values = etsyFormValuesFromProduct(saved as never);
    expect(values).toMatchObject({ etsyQuantity: "1", etsyVintageYear: "1972", etsyWhatIsIt: "finished", etsyFeatured: true, etsyAdsOptIn: false });
    expect(etsyPayloadFromValues(values)).toMatchObject({ ...saved, etsyRestockRequests: null, etsyGpsrSafetyInformation: null, etsyConsumerGuaranteeInfo: null });
  });

  it("sends null for empty inputs (so values can be cleared) and leaves promotions off by default", () => {
    const payload = etsyPayloadFromValues({});
    for (const value of Object.values(payload)) expect(value).toBeNull();
    expect(etsyPayloadFromValues({ etsyWhatIsIt: "supply", etsyTaxonomyId: "  " })).toMatchObject({ etsyIsSupply: true, etsyTaxonomyId: null });
    expect(etsyFormValuesFromProduct({})).toMatchObject({ etsyWhatIsIt: "", etsyAdsOptIn: undefined, etsyFeatured: undefined });
  });
});

describe("Etsy listing form messages (non-blocking; mirror the publish gate)", () => {
  it("flags Etsy title, tag and material limits", () => {
    expect(etsyLimitMessage("etsyTitle", "x".repeat(140))).toBeUndefined();
    expect(etsyLimitMessage("etsyTitle", "x".repeat(141))).toMatch(/at most 140 characters \(141 now\)/);
    expect(etsyLimitMessage("etsyTags", Array.from({ length: 14 }, (_, i) => `t${i}`).join(", "))).toMatch(/at most 13 tags/);
    expect(etsyLimitMessage("etsyTags", "a".repeat(21))).toMatch(/Each Etsy tag/);
    expect(etsyLimitMessage("etsyMaterials", Array.from({ length: 14 }, (_, i) => `m${i}`).join(","))).toMatch(/at most 13 materials .* to be verified/);
    expect(etsyLimitMessage("etsyTags", Array.from({ length: 14 }, (_, i) => `t${i}`).join(","))).toMatch(/required before publishing/);
  });

  it("explains invalid IDs, quantity, period, vintage year, vintage rule and GPSR contact", () => {
    const m = etsyFieldMessages({ etsyTaxonomyId: "abc", etsyQuantity: "0", etsyWhenMade: "seventies", etsyGpsrManufacturerContact: "phone me", etsySku: "S".repeat(33) });
    expect(m).toMatchObject({ etsyTaxonomyId: expect.stringMatching(/numeric Etsy ID/), etsyQuantity: "Whole number from 1 to 999", etsyWhenMade: expect.stringMatching(/made_to_order/), etsyGpsrManufacturerContact: "Email address or https:// URL", etsySku: expect.stringMatching(/at most 32 .* to be verified/) });
    expect(etsyFieldMessages({ etsyWhenMade: "1970s", etsyVintageYear: "1985" }).etsyVintageYear).toBe("Must fall within 'When was it made'");
    expect(etsyFieldMessages({ etsyWhoMade: "someone_else", etsyWhatIsIt: "finished", etsyWhenMade: "2020_2026" }).etsyWhenMade).toMatch(/^Etsy policy: .*must be vintage/);
    expect(etsyFieldMessages({ etsyWhoMade: "someone_else", etsyWhatIsIt: "supply", etsyWhenMade: "2020_2026" }).etsyWhenMade).toBeUndefined();
    expect(etsyFieldMessages(etsyFormValuesFromProduct(saved as never))).toEqual({});
  });
});

/** Stable (module-level) like ProductForm's own Field, so inputs are not remounted per keystroke. */
const Field = ({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) => (<label>{label}{children}{error && <span role="alert">{error}</span>}</label>);

function Harness({ initial = {} as EtsyListingFormValues }) {
  const [values, setValues] = useState<EtsyListingFormValues>(initial);
  return (<>
    <EtsyListingFormFields values={values} set={(k, v) => setValues((current) => ({ ...current, [k]: v }))} Field={Field} inputStyle={{}} />
    <output data-testid="state">{JSON.stringify(values)}</output>
  </>);
}

describe("Etsy listing form sections", () => {
  it("groups fields into labelled sections, marks required ones and keeps promotions unchecked", () => {
    render(<Harness />);
    for (const section of ["Listing identity", "About this item", "Shipping & returns", "Listing settings", "Legal & compliance (EU GPSR)"]) expect(screen.getByText(section)).toBeInTheDocument();
    for (const label of ["Etsy category (taxonomy ID) *", "Who made it? *", "When was it made? *", "Etsy shipping profile ID *"]) expect(screen.getByText(label)).toBeInTheDocument();
    // Form-only / unverified Etsy requirements are labelled as such, never as required (*).
    for (const label of ["What is it? (Etsy form; API requirement to be verified)", "Etsy processing profile ID (Etsy form; API requirement to be verified)", "Etsy return policy ID (Etsy form; API requirement to be verified)"]) expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Etsy Ads preference/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Feature this listing/ })).not.toBeChecked();
    expect(screen.getByText(/never filled automatically/)).toBeInTheDocument();
  });

  it("edits classification, reveals the exact Etsy period input and shows inline messages", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.selectOptions(screen.getByLabelText("Who made it?"), "someone_else");
    await user.selectOptions(screen.getByLabelText("What is it?"), "finished");
    await user.selectOptions(screen.getByLabelText("When was it made?"), "other");
    await user.type(screen.getByLabelText("Exact Etsy period value"), "2020_2026");
    expect(screen.getByRole("alert")).toHaveTextContent(/must be vintage/);
    await user.selectOptions(screen.getByLabelText("When was it made?"), "1970s");
    expect(screen.queryByLabelText("Exact Etsy period value")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Etsy shipping profile ID *"), "12x");
    expect(screen.getByRole("alert")).toHaveTextContent("Must be the numeric Etsy ID (digits only)");
    expect(JSON.parse(screen.getByTestId("state").textContent!)).toMatchObject({ etsyWhoMade: "someone_else", etsyWhatIsIt: "finished", etsyWhenMade: "1970s", etsyShippingProfileId: "12x" });
  });
});

describe("ProductForm integration", () => {
  it("saves an incomplete Etsy draft and sends typed Etsy values, with cleared values as null", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const product = { id: "p1", sku: "SKU-1", title: "Olympus", slug: "olympus", type: "unique_item", status: "draft", categoryId: "cat-1", stockQuantity: 1, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false, priceEur: 100, photos: [], images: [], marketplaceReadiness: {}, createdAt: "t", updatedAt: "t", etsyShopSectionId: "5678" };
    render(<ProductForm initialValues={productToFormValues(product as never)} submitLabel="Save Changes" onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText("Etsy category (taxonomy ID) *"), "1234");
    await user.selectOptions(screen.getByLabelText("Who made it?"), "someone_else");
    await user.selectOptions(screen.getByLabelText("What is it?"), "finished");
    await user.selectOptions(screen.getByLabelText("When was it made?"), "1970s");
    await user.clear(screen.getByLabelText("Shop section ID"));
    await user.click(screen.getByRole("checkbox", { name: /Etsy Ads preference/ }));
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      etsyTaxonomyId: "1234", etsyWhoMade: "someone_else", etsyIsSupply: false, etsyWhenMade: "1970s", etsyAdsOptIn: true,
      etsyShopSectionId: null, etsyShippingProfileId: null, etsyReturnPolicyId: null, etsyQuantity: null,
    });
  });

  it("the empty create form adds no Etsy values", () => {
    expect(etsyPayloadFromValues(emptyProductForm)).toEqual(Object.fromEntries(Object.keys(etsyPayloadFromValues({})).map((k) => [k, null])));
  });
});
