# Etsy listing form parity — Phase 1 implementation

This implements Phase 1 of `docs/etsy/ETSY-LISTING-FORM-PARITY.md` (Draft PR #368). The ERP can now **capture, persist and validate** the Etsy New Listing form's structured data.

**Nothing is sent to Etsy:**
- there is no Etsy API call, no listing creation, no promotion and no Etsy Ads;
- the existing Etsy publish payload is unchanged;
- each field's Open API v3 support must be verified in Phase 4 before it enters a live payload.

## Fields

All fields are optional and nullable on the product. Drafts always save. Etsy object IDs are stored as positive-integer strings, so large IDs lose no precision.

**Listing identity**

| Field (API / form) | Column | Rule |
|---|---|---|
| `etsyTaxonomyId` — Etsy category | `etsy_taxonomy_id` | Digits only. **Required to publish** |
| `etsyShopSectionId` — shop section | `etsy_shop_section_id` | Digits only, optional |
| `etsyQuantity` — listing quantity | `etsy_quantity` | Integer 1–999. Blank = ERP stock. **Must not exceed ERP stock** at publish; the canonical inventory is never changed |
| `etsySku` — SKU mapping | `etsy_sku` | Blank = ERP SKU. ≤ 32 characters is a **warning** (limit unverified) |

**Product classification**

| Field (API / form) | Column | Rule |
|---|---|---|
| `etsyWhoMade` — Who made it? | `etsy_who_made` | `i_did` / `collective` / `someone_else`. **Required** |
| `etsyIsSupply` — What is it? | `etsy_is_supply` | Finished product (false) or supply/tool (true). Asked by the Etsy form; **warning only** until API-verified |
| `etsyWhenMade` — When was it made? | `etsy_when_made` | `made_to_order`, decade (`1970s`, `1800s`), range (`2020_2026`) or `before_YYYY`. Validated by shape, because Etsy's current range values roll forward. **Required** |
| `etsyVintageYear` — vintage year | `etsy_vintage_year` | Optional four-digit year. Must fall inside `etsyWhenMade` |

**Shipping and returns**

| Field (API / form) | Column | Rule |
|---|---|---|
| `etsyShippingProfileId` | `etsy_shipping_profile_id` | Digits. **Required.** Separate from the ERP's generic `shippingProfile` |
| `etsyProcessingProfileId` | `etsy_processing_profile_id` | Digits. Asked by the Etsy form; **warning only** until API-verified |
| `etsyReturnPolicyId` | `etsy_return_policy_id` | Digits. Asked by the Etsy form; **warning only** until API-verified |

**Listing settings**

| Field (API / form) | Column | Rule |
|---|---|---|
| `etsyRenewalOption` | `etsy_renewal_option` | `automatic` / `manual`. Preference only |
| `etsyFeatured` | `etsy_featured` | Preference only, default unset (off) |
| `etsyAdsOptIn` | `etsy_ads_opt_in` | Default unset (off). The ERP **never** enables Etsy Ads; the publish gate warns when it is set |
| `etsyRestockRequests` | `etsy_restock_requests` | Preference only |

**Legal and compliance (EU GPSR)**

| Field (API / form) | Column | Rule |
|---|---|---|
| `etsyGpsrManufacturerName` / `Address` / `Contact` | `etsy_gpsr_manufacturer_*` | Seller-provided only. Contact must be an email or `https://` URL |
| `etsyGpsrResponsiblePersonName` / `Address` / `Contact` | `etsy_gpsr_responsible_person_*` | EU responsible person, when the manufacturer is outside the EU |
| `etsyGpsrSafetyInformation` | `etsy_gpsr_safety_information` | Free text, seller-provided |
| `etsyConsumerGuaranteeInfo` | `etsy_consumer_guarantee_info` | Free text, seller-provided |

The existing title, description, tags, materials, style, occasion, EUR price and listing status are unchanged.

Nothing is inferred: the AI suggestion workflow only writes title, description, tags, materials, style and occasion, and never fills classification, profiles or compliance data.

## Validation layers

- **Draft save (API schema)** is structural only:
  - enum values;
  - ID shape;
  - booleans;
  - quantity 1–999;
  - year plausibility;
  - vintage year inside "when made";
  - GPSR contact format.

  Incomplete or over-limit drafts save. `null` clears a value.
- **Readiness** (`marketplaceReadiness.etsy.missingFields`) adds only the publish-blocking fields: `taxonomyId`, `whoMade`, `whenMade` and `shippingProfileId`.
- **Publish gate** (`validatePublish`, Etsy channel only). Unverified assumptions never block:
  - **Errors** (Etsy API-required fields or hard limits, plus the ERP inventory rule):
    - taxonomy, who made, when made, shipping profile;
    - title ≤ 140 characters;
    - ≤ 13 tags of ≤ 20 characters each;
    - Etsy quantity ≤ ERP stock.
  - **Warnings** (form-only or not yet verified against Open API v3; promote to errors only after Phase 4 verification):
    - "What is it?", processing profile and return policy missing;
    - more than 13 materials, or a material over 45 characters;
    - SKU over 32 characters;
    - Etsy policy that items made by someone else must be vintage (20+ years) unless they are supplies;
    - Etsy Ads preference set (never enabled by the ERP);
    - GPSR manufacturer data missing or incomplete, and responsible-person data incomplete.
- **Admin form:** the same rules shown inline as non-blocking messages. Required fields are marked `*`, and sections are labelled required, optional, category-dependent or not-sent.

eBay and Noctella Web validation, readiness and payloads are unchanged.

## Migrations

- **SQLite:** 23 nullable columns, added through `db/migrate.ts` `ETSY_LISTING_FORM_COLUMNS` (`ALTER TABLE ... ADD COLUMN`) after the existing marketplace columns. `schema.sql` declares them last, so fresh and migrated databases share one column order. The Sprint 137 price rebuild appends the same list, keeping its `INSERT ... SELECT *` aligned.
- **PostgreSQL:** `0039_etsy_listing_form_parity.sql`, using `ADD COLUMN IF NOT EXISTS` only. There is no default, no `NOT NULL`, no backfill and no data rewrite. The four flags use native `boolean`.
- **Legacy products** keep `NULL` (= not provided), which reads as unset, never `false` or `0`.

## Open API v3 status (to verify in Phase 4; nothing here is sent yet)

| Status | Fields |
|---|---|
| Expected in the listing/inventory resources (confirm names, permissions and required-ness) | taxonomy, who made, is supply, when made (current value list), quantity, SKU (inventory endpoint), shop section, shipping profile, return policy, auto-renew |
| Uncertain | processing profile (newer Etsy concept), featured listing, restock requests |
| Possibly Etsy-side only | GPSR manufacturer, responsible person and safety fields, consumer guarantee, Etsy Ads |

## Phase 2 and later dependencies

- **Phase 2:** media (20 photos, 2 videos, cover/order/crop) with bounded memory use.
- **Phase 3:** taxonomy properties and category-specific required attributes, variations and personalization.
- **Phase 4:** OAuth, field-by-field API verification, a dry-run mapping, then draft creation. Owner approval is required before any write.
