export const dynamic = "force-dynamic";
import { getStockSyncStatus, stockSyncAudit } from "../../lib/stockSyncJobs";
import { StockSyncTriggers } from "./StockSyncTriggers";

export default async function StockSyncPage() {
  let summary: any = null;
  let audit: { items: any[] } = { items: [] };
  let error: string | null = null;
  try {
    summary = await getStockSyncStatus();
    audit = await stockSyncAudit();
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load stock sync status";
  }
  return (
    <main>
      <h1>Stock sync</h1>
      <StockSyncTriggers />
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        <>
          <p>Last run: {summary.lastRun ?? "Never"}</p>
          <p>Next run: {summary.nextRun ?? "Scheduler ready"}</p>
          <h2>Job counts</h2>
          <pre>{JSON.stringify(summary.jobs, null, 2)}</pre>
          <h2>Latest audit results</h2>
          <ul>{audit.items.map((a) => <li key={a.id}>{a.channel} {a.externalListingId}: {a.resultStatus} requested {a.requestedMarketplaceStock} confirmed {a.confirmedMarketplaceStock ?? "-"}</li>)}</ul>
        </>
      )}
    </main>
  );
}
