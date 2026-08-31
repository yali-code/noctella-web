import type { Metadata } from "next";
import { buildCanonicalUrl } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Returns Policy",
  description: "Noctella's return process for vintage objects, including change-of-mind and damaged-item returns.",
  alternates: { canonical: buildCanonicalUrl("/returns-policy") },
};

export default function ReturnsPolicyPage() {
  return (
    <section style={{ padding: "clamp(40px, 8vw, 60px) clamp(20px, 6vw, 40px)", maxWidth: 720 }}>
      <h1>Returns Policy</h1>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 16, color: "var(--noctella-ivory)", lineHeight: 1.7 }}>
        <p>
          Because every vintage object has its own history and condition, we describe and photograph our pieces as carefully as possible. We also want customers to have a clear and fair way to resolve a return.
        </p>
        <h2>30-Day Returns</h2>
        <p>You may request a return within 30 calendar days after delivery.</p>
        <p>
          To begin a return, contact <a href="mailto:support@noctella.com">support@noctella.com</a> before sending the item back. Please include your order number and the reason for the return.
        </p>
        <p>
          The 30-day Noctella return policy is in addition to, and does not reduce, any mandatory cancellation, withdrawal, conformity, or legal-guarantee rights that apply under consumer law.
        </p>
        <h2>Change of Mind</h2>
        <p>
          For an eligible change-of-mind return, the customer is responsible for arranging and paying the return shipping unless applicable law requires otherwise.
        </p>
        <p>Please use a tracked return service and retain proof of shipment until the return has been completed.</p>
        <p>
          After notifying us of the return, the item should be sent back promptly and, where a statutory withdrawal right applies, within the time required by applicable law.
        </p>
        <h2>Damaged, Faulty or Not as Described</h2>
        <p>
          If an item arrives damaged, the wrong item is delivered, or the object is materially different from its listing description, contact us at <a href="mailto:support@noctella.com">support@noctella.com</a>.
        </p>
        <p>
          When Noctella is responsible for the issue, we will arrange or reimburse a reasonable return method where a return is required, subject to applicable consumer law.
        </p>
        <p>Please retain the item, packaging, and any relevant photographs until we have reviewed the issue.</p>
        <h2>Return Condition</h2>
        <p>
          Returned objects should be sent back in substantially the same condition in which they were received, together with any accessories, cases, documents, or other items that were included in the order.
        </p>
        <p>
          Customers may inspect an item as reasonably necessary to establish its nature, characteristics, and condition. Where permitted by applicable law, a refund may be reduced if an item has been used, altered, damaged, or handled beyond what is reasonably necessary for inspection.
        </p>
        <h2>Vintage & Pre-Owned Condition</h2>
        <p>
          Most Noctella objects are vintage, antique, collectible, or pre-owned. Age-related patina, wear, marks, cosmetic imperfections, previous repairs, and functional limitations may form part of an object&apos;s documented condition.
        </p>
        <p>
          Condition characteristics that were clearly disclosed in the listing are not concealed defects merely because the object is old or previously owned.
        </p>
        <p>
          Nothing in this policy removes any mandatory rights relating to goods that are faulty, materially not as described, or otherwise do not conform to the sales contract.
        </p>
        <h2>Refunds</h2>
        <p>
          Once a return has been received, we will inspect the item and process any refund due without undue delay and within any deadline required by applicable law.
        </p>
        <p>Refunds are normally made to the original payment method.</p>
        <p>For change-of-mind returns, return shipping is not reimbursed unless required by applicable law.</p>
        <p>
          Original standard outbound delivery charges will be refunded where required by applicable consumer law. Premium or upgraded delivery costs are not refundable beyond the standard delivery amount unless required by law or the return results from an error for which Noctella is responsible.
        </p>
        <h2>Your Statutory Rights</h2>
        <p>This policy does not exclude, restrict, or replace mandatory consumer rights.</p>
        <p>
          For consumers who are entitled to a statutory distance-selling withdrawal right, including qualifying consumers in the European Union and the United Kingdom, those rights continue to apply independently of Noctella&apos;s voluntary 30-day return policy.
        </p>
        <p>
          Mandatory legal rights relating to faulty or non-conforming goods also continue to apply.
        </p>
      </div>
    </section>
  );
}
