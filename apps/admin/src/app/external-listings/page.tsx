export const dynamic = "force-dynamic";
import Link from "next/link";
import { listExternalListings } from "../../lib/marketplaceSync";
import { SyncListingButton } from "./SyncListingButton";

export default async function ExternalListingsPage({ searchParams }: { searchParams: Record<string, string> }) {
  const qs = new URLSearchParams(searchParams).toString();
  let items: any[] = [];
  let error: string | null = null;
  try { ({ items } = await listExternalListings(qs ? `?${qs}` : "")); } catch (err) { error = err instanceof Error ? err.message : "Failed to load external listings"; }
  return (
    <main>
      <h1>External Listings</h1>
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        <table>
          <thead><tr><th>Channel</th><th>Status</th><th>Product</th><th>Last sync state</th><th>Manual sync</th></tr></thead>
          <tbody>
            {items.map((l: any) => (
              <tr key={l.id}>
                <td>{l.channel}</td>
                <td>{l.externalStatus}</td>
                <td><Link href={`/products/${l.productId}`}>{l.productId}</Link></td>
                <td>{l.updatedAt}</td>
                <td><SyncListingButton listingId={l.id} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
