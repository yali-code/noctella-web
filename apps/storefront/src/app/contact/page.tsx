import type { Metadata } from "next";
import { buildCanonicalUrl } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Contact Noctella",
  description: "Contact Noctella customer support about an object, order, shipping, or return.",
  alternates: { canonical: buildCanonicalUrl("/contact") },
};

export default function ContactPage() {
  return (
    <section style={{ padding: "clamp(40px, 8vw, 60px) clamp(20px, 6vw, 40px)", maxWidth: 720 }}>
      <h1>Contact Noctella</h1>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 16, color: "var(--noctella-ivory)", lineHeight: 1.7 }}>
        <p>
          Questions about an object, an existing order, shipping, or a return? Our customer support team is here to help.
        </p>
        <section aria-labelledby="customer-support-heading">
          <h2 id="customer-support-heading" style={{ fontSize: 18 }}>Customer Support</h2>
          <p>
            Email: <a href="mailto:support@noctella.com">support@noctella.com</a>
          </p>
        </section>
        <p>
          We aim to respond to customer enquiries within two business days.
        </p>
        <p>
          For questions about an existing order, please include your order number and the email address used at checkout so we can assist you efficiently.
        </p>
        <p>
          If your question concerns a particular object, including condition, measurements, provenance, included accessories, or additional photographs, please include the product title or link.
        </p>
        <p>
          Noctella is based in Bulgaria and serves collectors across the European Union, the United Kingdom, the United States, and other destinations made available at checkout.
        </p>
      </div>
    </section>
  );
}
