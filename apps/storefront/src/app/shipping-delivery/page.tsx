import type { Metadata } from "next";
import Link from "next/link";
import { buildCanonicalUrl } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Shipping & Delivery",
  description: "How Noctella prepares, ships, tracks, and supports delivery of vintage objects.",
  alternates: { canonical: buildCanonicalUrl("/shipping-delivery") },
};

export default function ShippingDeliveryPage() {
  return (
    <section style={{ padding: "clamp(40px, 8vw, 60px) clamp(20px, 6vw, 40px)", maxWidth: 720 }}>
      <h1>Shipping & Delivery</h1>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 16, color: "var(--noctella-ivory)", lineHeight: 1.7 }}>
        <p>
          Every Noctella object is individually prepared and carefully packed in Bulgaria, with particular attention to the age, materials, and fragility of vintage pieces.
        </p>
        <h2>Processing Time</h2>
        <p>
          Orders are normally prepared and dispatched within 1–3 business days after the order and payment are confirmed. If an individual object requires different handling, the applicable information will be shown on the product page or during checkout.
        </p>
        <h2>Delivery Options & Estimates</h2>
        <p>
          Available shipping services, shipping charges, and estimated delivery times are shown during checkout based on the destination and the services currently available for that order.
        </p>
        <p>
          Delivery estimates are estimates rather than guaranteed arrival dates. Carrier disruption, weather, customs processing, public holidays, and other circumstances outside our direct control may affect international transit times.
        </p>
        <h2>Tracking</h2>
        <p>
          When tracking is available for the selected shipping service, tracking details are provided after dispatch so that the shipment can be followed during transit.
        </p>
        <h2>Packaging</h2>
        <p>
          Vintage and collectible objects are packed with care appropriate to their materials, age, condition, and fragility. Where practical, protective inner packaging and a suitable outer shipping container are used to reduce the risk of movement or transit damage.
        </p>
        <h2>Customs, Duties & Import Taxes</h2>
        <p>
          Orders shipped from Bulgaria to destinations outside the European Union may be subject to import duties, taxes, customs charges, or carrier handling fees imposed by the destination country.
        </p>
        <p>
          Unless such charges are explicitly collected during checkout or applicable law requires otherwise, these charges are the responsibility of the recipient.
        </p>
        <p>
          Customs requirements and charges vary by country and cannot always be calculated by Noctella in advance. See <Link href="/customs-duties">Customs & Import Duties</Link> for more information.
        </p>
        <h2>Delivery Address</h2>
        <p>
          Customers are responsible for providing a complete and accurate delivery address. If you notice an address error, contact <a href="mailto:support@noctella.com">support@noctella.com</a> as soon as possible. Once an order has been dispatched, an address change may no longer be possible.
        </p>
        <h2>Delivery Problems</h2>
        <p>
          If an order arrives damaged, appears to have been mishandled in transit, or does not arrive within the expected delivery period, contact <a href="mailto:support@noctella.com">support@noctella.com</a> as soon as reasonably possible.
        </p>
        <p>
          When reporting transit damage, please keep the item and its packaging and provide clear photographs where possible. This helps us assess the issue and work with the shipping carrier.
        </p>
        <p>
          Nothing on this page limits any mandatory consumer rights that apply to your order.
        </p>
      </div>
    </section>
  );
}
