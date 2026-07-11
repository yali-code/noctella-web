"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  type CartItem,
  cartEurSubtotal,
  cartUsdSubtotal,
  clearCartPersisted,
  getCart,
  removeFromCartPersisted,
} from "@/lib/cart";

function formatProductType(type: string): string {
  return type
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export default function CartPage() {
  const [items, setItems] = useState<CartItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setItems(getCart());
    setLoaded(true);
  }, []);

  function handleRemove(productId: string) {
    const updated = removeFromCartPersisted(productId);
    setItems(updated);
    window.dispatchEvent(new Event("noctella:cart-updated"));
  }

  function handleClear() {
    const updated = clearCartPersisted();
    setItems(updated);
    window.dispatchEvent(new Event("noctella:cart-updated"));
  }

  const eurSubtotal = cartEurSubtotal(items);
  const usdSubtotal = cartUsdSubtotal(items);

  return (
    <section style={{ padding: "48px 40px" }}>
      <h1>Cart</h1>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />

      {loaded && items.length === 0 && (
        <div style={{ padding: "40px 0", textAlign: "center" }}>
          <p style={{ color: "var(--noctella-aged-bronze)" }}>Your cart is empty.</p>
          <Link href="/shop" style={{ fontSize: 14 }}>
            Return to Shop
          </Link>
        </div>
      )}

      {items.length > 0 && (
        <>
          <div className="noctella-panel" style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid var(--noctella-antique-gold)" }}>
                  <th style={thStyle}></th>
                  <th style={thStyle}>Title</th>
                  <th style={thStyle}>Type</th>
                  <th style={thStyle}>EUR Price</th>
                  <th style={thStyle}>USD Price</th>
                  <th style={thStyle}>Quantity</th>
                  <th style={thStyle}></th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.productId} style={{ borderBottom: "1px solid rgba(122,106,79,0.3)" }}>
                    <td style={tdStyle}>
                      {item.primaryImageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={item.primaryImageUrl}
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
                    <td style={tdStyle}>
                      <Link href={`/product/${item.slug}`} style={{ color: "var(--noctella-ivory)" }}>
                        {item.title}
                      </Link>
                    </td>
                    <td style={tdStyle}>{formatProductType(item.productType)}</td>
                    <td style={tdStyle}>€{item.eurPrice.toFixed(2)}</td>
                    <td style={tdStyle}>{item.usdPrice !== undefined ? `$${item.usdPrice.toFixed(2)}` : "—"}</td>
                    <td style={tdStyle}>{item.quantity}</td>
                    <td style={tdStyle}>
                      <button onClick={() => handleRemove(item.productId)} style={linkButtonStyle}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-end",
              flexWrap: "wrap",
              gap: 16,
              marginTop: 24,
            }}
          >
            <button onClick={handleClear} style={secondaryButtonStyle}>
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
              <Link
                href="/checkout"
                style={{
                  ...primaryCtaStyle,
                  display: "inline-block",
                  marginTop: 10,
                  textDecoration: "none",
                }}
              >
                Continue to Checkout
              </Link>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

const thStyle: React.CSSProperties = {
  padding: "10px 12px",
  color: "var(--noctella-bright-star-gold)",
  fontWeight: 500,
};

const tdStyle: React.CSSProperties = {
  padding: "10px 12px",
};

const linkButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--noctella-bright-star-gold)",
  cursor: "pointer",
  fontSize: 13,
  padding: 0,
};

const secondaryButtonStyle: React.CSSProperties = {
  padding: "10px 18px",
  background: "transparent",
  color: "var(--noctella-ivory)",
  border: "1px solid var(--noctella-aged-bronze)",
  borderRadius: 4,
  fontSize: 14,
  cursor: "pointer",
};

const primaryCtaStyle: React.CSSProperties = {
  padding: "10px 18px",
  background: "var(--noctella-antique-gold)",
  color: "var(--noctella-night-navy)",
  border: "none",
  borderRadius: 4,
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};
