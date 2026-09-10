import Link from "next/link";

export function CommerceTrustStrip() {
  return (
    <aside className="sf-trust-strip" aria-label="Shopping information">
      <p><strong>Cash on Delivery</strong><span>Where available for the selected object.</span></p>
      <p><strong>Clear shipping costs</strong><span>Options and charges are shown at checkout.</span></p>
      <p><strong>Individual condition</strong><span>Vintage and collectible condition is described item by item.</span></p>
      <Link href="/shipping-delivery">Shipping details</Link>
    </aside>
  );
}
