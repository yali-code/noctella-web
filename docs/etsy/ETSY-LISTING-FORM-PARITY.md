# Etsy Listing Form Parity — Noctella ERP

Status: Implementation specification; no production execution authorized.

## Source and scope
Mapped against seller-supplied Etsy New Listing form (October 2026). Example listing content is deliberately excluded. Etsy API support must be checked per field before implementing write actions.

## Existing ERP Etsy fields
etsyTitle, etsyDescription, etsyTags, etsyMaterials, etsyStyle, etsyOccasion, etsyListingPriceEur, etsyListingStatus. Shared product inventory includes SKU, quantity, photos and generic shipping profile. Existing Etsy publication envelope carries title, description, price, images and metadata {tags, materials, style, occasion}.

## Phase 1: Form parity and structured data
- Etsy category taxonomy ID (not merely local product category); category mapping and validation.
- Who made it; what is it; when made (vintage decade/year), category-specific requirements.
- Etsy shipping profile ID, processing profile, return policy ID, shop section ID, listing quantity and SKU mapping.
- Separate seller-provided legal/GPSR manufacturer, safety and applicable guarantee information; never invent compliance claims.
- Renewal preference, featured listing and Etsy Ads opt-in; default all promotional actions off.
- Tags max 13, material limit from UI, title max 140; validation should be server-side and reflect current Etsy API limits.
- Optional: global/US pricing, tariff estimate (do not automatically infer duty or promise inclusive pricing), restock request preference.
- Keep generic ERP shippingProfile distinct from Etsy provider profile ID.
- Persist all new Etsy fields in Postgres and SQLite schema, API validation, shared Product types, admin form and tests; migration/backfill must be safe and additive.

## Phase 2: Media
- Up to 20 Etsy photos and up to 2 videos per seller UI; explicit cover and order, thumbnail crop metadata when supported.
- Reuse ERP product photo assets without loading all originals into API memory; stream/bounded processing, important due to 512MiB production OOM history.
- Preserve media references and upload states; API-specific capability checks required.

## Phase 3: Dynamic attributes and options
- Etsy taxonomy properties, allowed values and category-specific validation.
- Variations and inventory mapping, buyer personalization/custom options (up to five shown in supplied UI) only where API supports them.
- No fabricated maker, era, materials, origin or compliance declarations.

## Phase 4: API publishing
- OAuth with scoped authorization, secrets handled server-side.
- Dry-run readiness checks and field mapping; create draft first.
- Upload media and inventory, reconcile external Etsy listing ID, idempotent retry, error logging without credentials.
- Separate explicit owner action for publish; no automatic paid promotion or ads.
- Cross-channel stock sync safeguards, partial failures and rollback/reconciliation.
- Tests, staging acceptance, explicit approval before merge/deploy/production write.

## Open API verification questions
- Which form fields are available through current Open API v3, and with which endpoints/permissions?
- Video and thumbnail crop APIs, custom options, GPSR fields, processing profile, shop section, renewal, featured, restock requests, global prices, Etsy Ads toggle.
- Which fields must remain manual Etsy-side settings?

## Acceptance criteria
1. Seller can save and review an Etsy-complete draft in ERP without publishing.
2. Etsy required fields validate per taxonomy and listing type.
3. Existing products and eBay/Noctella Web publishing remain unchanged.
4. No provider writes before separately authorized integration and owner approval.
5. Staging tests pass; production remains untouched until explicit release approval.
