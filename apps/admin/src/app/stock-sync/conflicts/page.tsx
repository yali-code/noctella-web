export const dynamic = "force-dynamic";
import Link from "next/link";
import { listConflicts, listingLink, productLink } from "../../../lib/stockSyncJobs";

export default async function ConflictsPage() {
  let items: Awaited<ReturnType<typeof listConflicts>>["items"] = [];
  let error: string | null = null;
  try { ({ items } = await listConflicts()); } catch (err) { error = err instanceof Error ? err.message : "Failed to load stock sync conflicts"; }
  return (
    <main>
      <h1>Stock sync conflicts</h1>
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        <table>
          <tbody>
            {items.map((c) => (
              <tr key={c.id}>
                <td><Link href={`/stock-sync/conflicts/${c.id}`}>{c.conflictType}</Link></td>
                <td>{c.status}</td>
                <td>{c.channel}</td>
                <td><Link href={productLink(c.productId)}>{c.productId}</Link></td>
                <td><Link href={listingLink(c.externalListingId)}>{c.externalListingId}</Link></td>
                <td>{c.localStock} / {c.marketplaceStock}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
