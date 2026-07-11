export default function ShippingDeliveryPage() {
  return (
    <section style={{ padding: "60px 40px", maxWidth: 720 }}>
      <h1>Shipping & Delivery</h1>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 16, color: "var(--noctella-ivory)", lineHeight: 1.7 }}>
        <p>
          Each object is carefully packed to protect it in transit. Shipping timelines and carrier
          details vary by item and destination and will be confirmed at the time of your order.
        </p>
        <p>
          Individual product pages may include a specific shipping note where relevant. This page will
          be updated with complete shipping terms as our ordering process is finalized.
        </p>
      </div>
    </section>
  );
}
