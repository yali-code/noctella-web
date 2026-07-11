export default function ContactPage() {
  return (
    <section style={{ padding: "60px 40px", maxWidth: 720 }}>
      <h1>Contact</h1>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 16, color: "var(--noctella-ivory)", lineHeight: 1.7 }}>
        <p>
          Have a question about a piece, an offer, or anything else? We&apos;d like to hear from you.
        </p>
        <p style={{ color: "var(--noctella-aged-bronze)" }}>
          Contact details and a message form will be published here soon.
        </p>
      </div>
    </section>
  );
}
