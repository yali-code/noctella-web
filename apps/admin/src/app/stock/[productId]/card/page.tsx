"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { StockMovement } from "@noctella/shared";
import { api, resolveApiAssetUrl } from "@/lib/api";
import { purchasingApi, type ProductPurchaseHistory } from "@/lib/erpPurchasingBridge";
import { allStockMovements, openingStockMovement, stockDate } from "@/lib/stockDashboard";
import { buildProductCardSummary, formatEur } from "@/lib/productCardDomain";
import type { Category, ProductDetail } from "@/lib/types";

const recorded = (value?: string | null) => value || "Not recorded";
const cost = (value?: number | null) => value == null || !Number.isFinite(value) ? "Not recorded" : formatEur(value);

export default function StockCardPage({ params }: { params: { productId: string } }) {
  const [data, setData] = useState<{ product: ProductDetail; movements: StockMovement[]; category: Category | null } | null>(null);
  const [history, setHistory] = useState<ProductPurchaseHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setData(null); setHistory(null); setError(null); setHistoryError(null);
    Promise.all([api.get<ProductDetail>(`/api/products/${encodeURIComponent(params.productId)}`), allStockMovements(params.productId)])
      .then(async ([product, movements]) => {
        const category = product.categoryId ? await api.get<Category>(`/api/categories/${encodeURIComponent(product.categoryId)}`) : null;
        if (active) setData({ product, movements, category });
      }).catch((err) => { if (active) setError(err.message); });
    purchasingApi.productPurchaseHistory(params.productId).then((value) => { if (active) setHistory(value); })
      .catch(() => { if (active) setHistoryError("Purchase history could not be loaded. Please reload to try again."); });
    return () => { active = false; };
  }, [params.productId]);

  if (error) return <div><h1>Stock Card</h1><p role="alert">{error}</p></div>;
  if (!data) return <p role="status">Loading Stock Card…</p>;
  const { product, movements, category } = data;
  const opening = openingStockMovement(product.id, movements);
  const latest = movements.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  const photo = buildProductCardSummary(product).media.primaryPhoto ?? product.images.find((image) => image.isPrimary) ?? product.images[0];

  return <div>
    <Link href="/stock">Back to Stock</Link>
    <h1>Stock Card · {product.title}</h1>
    <section className="noctella-panel" style={panel} aria-label="Product identity">
      {photo && <img src={resolveApiAssetUrl(photo.url)} alt={photo.altText || product.title} style={{ width: 180, height: 180, objectFit: "contain", float: "right" }} />}
      <dl style={details}>
        <dt>SKU</dt><dd>{product.sku}</dd>
        <dt>Category</dt><dd>{category?.name ?? "Not recorded"}</dd>
        <dt>Product type</dt><dd>{product.type}</dd>
        <dt>Status</dt><dd>{product.status}</dd>
        <dt>Current quantity</dt><dd>{product.stockQuantity}</dd>
      </dl>
    </section>
    <section className="noctella-panel" style={panel} aria-label="Stock history">
      <h2>Stock</h2>
      <dl style={details}>
        <dt>Stocked on</dt><dd>{stockDate(opening?.createdAt)}</dd>
        <dt>Opening quantity</dt><dd>{opening?.quantityDelta ?? "—"}</dd>
        <dt>Latest movement</dt><dd>{stockDate(latest?.createdAt)}</dd>
      </dl>
      <Link href={`/stock/${product.id}`} style={{ marginRight: 20 }}>Timeline</Link>
      <Link href={`/products/${product.id}/label`}>Print Barcode</Link>
    </section>
    <section className="noctella-panel" style={panel} aria-label="Acquisition">
      <h2>Acquisition</h2>
      <p>Product purchase cost (per unit): {cost(product.purchaseCost)}</p>
      {historyError ? <p role="alert">{historyError}</p> : !history ? <p role="status">Loading purchase history…</p> : !history.items.length ?
        <dl style={details}><dt>Purchase source</dt><dd>Not recorded</dd><dt>Supplier</dt><dd>Not recorded</dd><dt>Purchase line price</dt><dd>Not recorded</dd></dl> :
        history.items.map((entry) => <article key={entry.purchaseLine.id} style={{ borderTop: "1px solid var(--noctella-antique-gold)", marginTop: 16 }}>
          <h3>Purchase {entry.purchase.id} · Line {entry.purchaseLine.id}</h3>
          <dl style={details}>
            <dt>Receipt status</dt><dd>{entry.receiptStatus}</dd>
            <dt>Purchase line unit cost</dt><dd>{cost(entry.purchaseLine.unitPurchaseCost)}</dd>
            <dt>Landed unit cost</dt><dd>{cost(entry.landedCost?.landedUnitCost)}</dd>
            <dt>Landed total cost</dt><dd>{cost(entry.landedCost?.landedTotalCost)}</dd>
            <dt>Source type</dt><dd>{recorded(entry.purchase.sourceType)}</dd>
            <dt>Supplier</dt><dd>{recorded(entry.supplier?.name)}</dd>
            <dt>Auction house</dt><dd>{recorded(entry.purchase.auctionHouse)}</dd>
            <dt>External reference</dt><dd>{recorded(entry.sourceReferences.externalReference)}</dd>
            <dt>Invoice reference</dt><dd>{recorded(entry.sourceReferences.invoiceReferenceNumber)}</dd>
            <dt>ERP reference</dt><dd>{recorded(entry.sourceReferences.erpReferenceId)}</dd>
            <dt>Ordered date</dt><dd>{stockDate(entry.dates.orderedAt)}</dd>
            <dt>Received date</dt><dd>{stockDate(entry.dates.receivedAt)}</dd>
          </dl>
        </article>)}
    </section>
  </div>;
}

const panel: React.CSSProperties = { padding: 20, margin: "20px 0", display: "flow-root" };
const details: React.CSSProperties = { display: "grid", gridTemplateColumns: "minmax(140px, 200px) minmax(0, 1fr)", gap: "10px 16px", overflowWrap: "anywhere" };
