export default function CustomsDutiesPage() {
  return (
    <section style={{ padding: "60px 40px", maxWidth: 720 }}>
      <h1>Customs & Import Duties</h1>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 16, color: "var(--noctella-ivory)", lineHeight: 1.7 }}>
        <p>
          Buyers are responsible for any customs duties, import taxes, or local charges that may occur
          during international shipping.
        </p>
        <p>
          These charges are determined by your country&apos;s customs authority and are not included in
          the item price or shipping cost shown at checkout.
        </p>
      </div>
    </section>
  );
}
