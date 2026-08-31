import Link from "next/link";

export default function Page() {
  return (
    <section style={{ padding: "clamp(40px, 8vw, 60px) clamp(20px, 6vw, 40px)", maxWidth: 720 }}>
      <h1>Customer Account</h1>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 16, color: "var(--noctella-ivory)", lineHeight: 1.7 }}>
        <p style={{ margin: 0 }}>
          Noctella currently operates with guest checkout, so a customer account is not required to purchase an object.
        </p>
        <p style={{ margin: 0 }}>
          For help with an existing order, shipping, or a return, contact{" "}
          <Link href="/contact">Customer Support at support@noctella.com</Link>.
        </p>
        <p style={{ margin: 0 }}>
          <Link href="/shop">Browse the shop</Link>
        </p>
      </div>
    </section>
  );
}
