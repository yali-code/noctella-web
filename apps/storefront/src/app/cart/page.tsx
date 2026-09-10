"use client";

import Link from "next/link";
import { resolveApiAssetUrl } from "@/lib/api";
import { CartFreshnessBlocker, useCartFreshness } from "@/components/CartFreshness";
import {
  cartEurSubtotal,
  cartUsdSubtotal,
  clearCartPersisted,
  removeFromCartPersisted,
} from "@/lib/cart";

function formatProductType(type: string): string {
  return type
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export default function CartPage() {
  const freshness = useCartFreshness();
  const items = freshness.items;

  function handleRemove(productId: string) {
    removeFromCartPersisted(productId);
    void freshness.reconcileNow();
    window.dispatchEvent(new Event("noctella:cart-updated"));
  }

  function handleClear() {
    clearCartPersisted();
    void freshness.reconcileNow();
    window.dispatchEvent(new Event("noctella:cart-updated"));
  }

  const eurSubtotal = cartEurSubtotal(items);
  const usdSubtotal = cartUsdSubtotal(items);

  if (!freshness.canProceed) return <CartFreshnessBlocker freshness={freshness} title="Cart" />;

  return (
    <section className="sf-cart">
      <h1>Cart</h1>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />

      {!freshness.loading && items.length === 0 && (
        <div style={{ padding: "40px 0", textAlign: "center" }}>
          <p style={{ color: "var(--noctella-aged-bronze)" }}>Your cart is empty.</p>
          <Link href="/shop" style={{ fontSize: 14 }}>
            Return to Shop
          </Link>
        </div>
      )}

      {items.length > 0 && (
        <>
          <div className="noctella-panel sf-cart-table-wrap">
            <table className="sf-cart-table">
              <thead>
                <tr>
                  <th><span className="sf-visually-hidden">Image</span></th>
                  <th>Title</th>
                  <th>Type</th>
                  <th>EUR Price</th>
                  <th>USD Price</th>
                  <th>Quantity</th>
                  <th><span className="sf-visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.productId}>
                    <td className="sf-cart-table__image" data-label="Image">
                      {item.primaryImageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={resolveApiAssetUrl(item.primaryImageUrl)}
                          alt={item.title}
                          style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 4 }}
                        />
                      ) : (
                        <div
                          style={{
                            width: 48,
                            height: 48,
                            borderRadius: 4,
                            background: "var(--noctella-night-navy)",
                            border: "1px solid var(--noctella-aged-bronze)",
                          }}
                        />
                      )}
                    </td>
                    <td data-label="Title">
                      <Link href={`/product/${item.slug}`} style={{ color: "var(--noctella-ivory)" }}>
                        {item.title}
                      </Link>
                    </td>
                    <td data-label="Type">{formatProductType(item.productType)}</td>
                    <td data-label="EUR Price">€{item.eurPrice.toFixed(2)}</td>
                    <td data-label="USD Price">{item.usdPrice !== undefined ? `$${item.usdPrice.toFixed(2)}` : "—"}</td>
                    <td data-label="Quantity">{item.quantity}</td>
                    <td className="sf-cart-table__action" data-label="Action">
                      <button className="sf-cart-link-button" onClick={() => handleRemove(item.productId)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="sf-cart-summary">
            <button onClick={handleClear} className="sf-cart-secondary-button">
              Clear Cart
            </button>

            <div style={{ textAlign: "right" }}>
              <p style={{ margin: 0, fontSize: 15 }}>
                Subtotal: €{eurSubtotal.toFixed(2)}
                {usdSubtotal !== undefined && (
                  <span style={{ color: "var(--noctella-aged-bronze)", marginLeft: 8, fontSize: 13 }}>
                    (${usdSubtotal.toFixed(2)})
                  </span>
                )}
              </p>
              <Link href="/checkout" className="sf-cart-checkout-link">
                Continue to Checkout
              </Link>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
