# ADS-002A — Hybrid AI Performance Funnel / Marketplace Sales First

Status: **Draft foundation only** — no deployment, tracking, pixels, campaigns, budgets, schema changes, or production writes.

## Objective
Increase profitable *external* traffic and orders for Noctella's eBay and Etsy listings. Existing eBay Promoted Listings remain untouched. The ERP and existing Analytics/Social services stay authoritative.

## This pull request
- Adds a pure, fail-closed helper deciding whether a canonical product and external listing can appear as a marketplace purchase destination.
- Rejects unknown stock, non-published/paused products, non-active listings, non-eBay/Etsy channels and unsafe/non-HTTPS URL origins.
- Adds focused unit tests. No API route or storefront UI is wired in this change.

## Follow-up integration, not yet implemented
1. Resolve the canonical sellable quantity through the existing inventory/stock service (do **not** assume `products.stock` exists).
2. Read `external_listings` in a bounded, read-only query and derive eligible links server-side, keeping all internal listing snapshots private.
3. Add marketplace destination buttons on dedicated campaign landing pages only; do not change existing storefront cart semantics.
4. Track `page_view`, `view_item`, and `marketplace_outbound_click` subject to consent; never map click to `purchase`.
5. Deploy CMP and test GA4/Meta/Pinterest integrations only after explicit configuration and verified consent behavior.
6. Compare direct-to-marketplace and Noctella landing-page routes with market-specific campaigns; avoid calling correlation a Cassini ranking effect.

## Guardrails
- No marketplace checkout pixels or fabricated purchase events.
- No automated uploads of Etsy/eBay customer identities to ad providers.
- Do not automatically redirect or publish ads while inventory reconciliation is stale.
- All campaign creation, ad-spend permissions, and budget increases require owner approval.
- Existing production SQLite, social publishing chain, analytics collector, and R2 backup arrangements remain unchanged.
- Follow-up must add a true inventory-stock resolver, provider status mapping, tests and browser consent audit before any outward use.

## Acceptance checklist
- [x] Pure eligibility rules authored
- [x] Unit tests authored
- [ ] CI run verified
- [ ] External listing status semantics reviewed with actual provider adapters
- [ ] Canonical available-stock resolver identified
- [ ] Read-only endpoint and landing page separately reviewed
- [ ] Consent and conversion measurement verified
- [ ] No production deployment until owner approval
