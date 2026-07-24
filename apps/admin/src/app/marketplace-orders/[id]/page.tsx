export const dynamic = "force-dynamic";
import Link from "next/link";
import { getMarketplaceOrder, retryEligible, unmatchedWarnings, safeError } from "../../../lib/marketplaceSync";
import { RetryOrderButton } from "../RetryOrderButton";

export default async function MarketplaceOrderDetail({ params }: { params: { id: string } }) {
  let o: any = null;
  let error: string | null = null;
  try { o = await getMarketplaceOrder(params.id); } catch (err) { error = err instanceof Error ? err.message : "Failed to load marketplace order"; }
  if (error || !o) return <main><h1>Marketplace Order</h1><p role="alert">{error ?? "Marketplace order not found"}</p></main>;
  const warnings = unmatchedWarnings(o.items);
  return (
    <main>
      <h1>Marketplace Order {o.externalOrderNumber ?? o.externalOrderId}</h1>
      <p>{o.channel} · {o.status} · {o.total} {o.currency}</p>
      {o.internalOrderId && <p>Internal order: <Link href={`/orders/${o.internalOrderId}`}>{o.internalOrderId}</Link></p>}
      {retryEligible(o) && <RetryOrderButton orderId={o.id} />}
      {warnings.map((w) => <p key={w} role="alert">{w}</p>)}
      <h2>Items</h2>
      <ul>{o.items.map((i: any) => <li key={i.id}>{i.titleSnapshot} × {i.quantity} — {i.productId ? <Link href={`/products/${i.productId}`}>{i.productId}</Link> : "unmatched"}</li>)}</ul>
      <h2>Raw payload snapshot</h2>
      <pre>{JSON.stringify(o.rawPayloadSnapshot, null, 2)}</pre>
      <p>{safeError(o.lastError)}</p>
    </main>
  );
}
