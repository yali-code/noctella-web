export const dynamic = "force-dynamic";
import Link from "next/link";
import { listMarketplaceOrders, retryEligible } from "../../lib/marketplaceSync";
import { RetryOrderButton } from "./RetryOrderButton";

export default async function MarketplaceOrdersPage({ searchParams }: { searchParams: Record<string, string> }) {
  const qs = new URLSearchParams(searchParams).toString();
  let items: any[] = [];
  let error: string | null = null;
  try { ({ items } = await listMarketplaceOrders(qs ? `?${qs}` : "")); } catch (err) { error = err instanceof Error ? err.message : "Failed to load marketplace orders"; }
  return (
    <main>
      <h1>Marketplace Orders</h1>
      <p>Searchable imported eBay and Etsy orders with retry visibility.</p>
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        <table>
          <thead><tr><th>Channel</th><th>External order</th><th>Buyer</th><th>Total</th><th>Status</th><th>Internal</th><th>Action</th></tr></thead>
          <tbody>
            {items.map((o: any) => (
              <tr key={o.id}>
                <td>{o.channel}</td>
                <td><Link href={`/marketplace-orders/${o.id}`}>{o.externalOrderNumber ?? o.externalOrderId}</Link></td>
                <td>{o.buyerName ?? o.buyerEmail ?? "—"}</td>
                <td>{o.total} {o.currency}</td>
                <td>{o.status}</td>
                <td>{o.internalOrderId ? <Link href={`/orders/${o.internalOrderId}`}>{o.internalOrderId}</Link> : "—"}</td>
                <td>{retryEligible(o) ? <RetryOrderButton orderId={o.id} /> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
