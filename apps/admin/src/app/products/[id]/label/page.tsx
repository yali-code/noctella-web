"use client";

import JsBarcode from "jsbarcode";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { Category, PaginatedResult, ProductDetail } from "@/lib/types";

/**
 * Sprint 137: Stock Receipt / barcode label route - serves BOTH the immediate post-Stock-
 * Acceptance receipt (navigated to automatically once Finalize succeeds, see
 * ApplyAndFinalizeSection.tsx) and later reprints from /stock. Always fetches fresh authoritative
 * Product data on load via the existing GET /api/products/:id read (no new backend endpoint) -
 * never trusts pre-acceptance local form state, so a reprint always shows the current real SKU/
 * title/quantity/category even if they were edited since the item was accepted into stock.
 *
 * Barcode payload is exactly `product.sku` (e.g. "NOC-000123") - the sole internal warehouse
 * identity. No second identifier is introduced or read (never the unrelated ERP Integration
 * product_erp_metadata.barcodeValue). Rendered as a real scannable Code 128 barcode via the one
 * new jsbarcode dependency, with the human-readable SKU also printed as plain text alongside it.
 *
 * Sprint 138: a short, display-only category code is derived from the already-fetched Category
 * slug (see deriveCategoryCode) and shown next to the canonical SKU. It is never persisted, never
 * part of Product identity, and never encoded into the barcode - the JsBarcode call below still
 * receives exactly `product.sku`. It recalculates fresh on every load/reprint, so it always
 * reflects the Product's current Category, and simply omits itself if no code can be derived.
 */
function deriveCategoryCode(slug: string | null | undefined): string | null {
  if (!slug) return null;
  const segments = slug.toLowerCase().split("-").filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  if (segments.length === 1) return segments[0].slice(0, 3).toUpperCase();
  const [first, second] = segments;
  if (first.length <= 4) return (first.slice(0, 1) + second.slice(0, 3)).toUpperCase();
  return first.slice(0, 3).toUpperCase();
}

export default function ProductLabelPage({ params }: { params: { id: string } }) {
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [categoryName, setCategoryName] = useState<string | null>(null);
  const [categorySlug, setCategorySlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [barcodeReady, setBarcodeReady] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    setError(null);
    api
      .get<ProductDetail>(`/api/products/${params.id}`)
      .then((loaded) => {
        setProduct(loaded);
        if (!loaded.categoryId) return;
        return api
          .get<PaginatedResult<Category>>("/api/categories?pageSize=100")
          .then((res) => {
            const category = res.items.find((c) => c.id === loaded.categoryId);
            setCategoryName(category?.name ?? null);
            setCategorySlug(category?.slug ?? null);
          })
          .catch(() => {});
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load product"));
  }, [params.id]);

  // Sprint 137: renders only once the Product (and therefore its real sku) has actually loaded and
  // the <svg> is mounted - the Print action stays disabled (barcodeReady) until this effect has
  // run, so window.print() can never be invoked before the barcode is actually drawn.
  useEffect(() => {
    if (!product || !svgRef.current) return;
    setBarcodeReady(false);
    JsBarcode(svgRef.current, product.sku, {
      format: "CODE128",
      displayValue: false,
      width: 2,
      height: 60,
      margin: 0,
    });
    setBarcodeReady(true);
  }, [product]);

  if (error) return <p style={{ color: "#c86a6a" }}>{error}</p>;
  if (!product) return <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading...</p>;

  const quantityLabel = `${product.stockQuantity} item${product.stockQuantity === 1 ? "" : "s"}`;
  const categoryCode = deriveCategoryCode(categorySlug);
  const skuIdentifier = categoryCode ? `${categoryCode} · ${product.sku}` : product.sku;

  return (
    <div>
      <style>{`
        @media print {
          .noctella-label-screen-only { display: none !important; }
          .noctella-label-print {
            position: fixed;
            top: 0;
            left: 0;
            width: 60mm;
            height: 40mm;
            margin: 0;
            padding: 3mm;
          }
        }
      `}</style>

      <div className="noctella-label-screen-only">
        <h1>Stock Accepted</h1>
        <p style={{ color: "var(--noctella-aged-bronze)" }}>
          The Product and Inventory were created. Print the barcode label below, or return here later from Stock to reprint it.
        </p>
        <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />
      </div>

      <div
        className="noctella-panel noctella-label-print"
        style={{ padding: 20, maxWidth: 320, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}
      >
        <p style={{ margin: 0, fontSize: 14, fontFamily: "monospace", letterSpacing: 1 }}>{skuIdentifier}</p>
        <p style={{ margin: 0, fontSize: 16, fontWeight: 600, textAlign: "center" }}>{product.title}</p>
        <svg ref={svgRef} role="img" aria-label={`Barcode for SKU ${product.sku}`} />
        <p style={{ margin: 0, fontSize: 12, color: "var(--noctella-aged-bronze)", textAlign: "center" }}>
          {quantityLabel}
          {categoryName ? ` · ${categoryName}` : ""}
        </p>
      </div>

      <div className="noctella-label-screen-only" style={{ marginTop: 16 }}>
        <button
          onClick={() => window.print()}
          disabled={!barcodeReady}
          style={{
            padding: "10px 18px",
            background: "var(--noctella-antique-gold)",
            color: "var(--noctella-night-navy)",
            border: "none",
            borderRadius: 4,
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Print Barcode
        </button>
      </div>
    </div>
  );
}
