import { erpReportsApi, mapSupplier, periodLabels, comparisonLabels, type ReportQuery } from "@/lib/erpReportsAnalyticsBridge";
import { CompletenessWarnings, ExportLinks, ReportError, formatMetricValue } from "@/components/reports/ReportSections";

export const dynamic = "force-dynamic";

function flatQuery(searchParams: Record<string, string | string[] | undefined>): ReportQuery {
  const out: ReportQuery = {};
  for (const [k, v] of Object.entries(searchParams)) if (typeof v === "string") out[k] = v;
  return out;
}

export default async function Page({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const query = flatQuery(searchParams);
  let mapped: ReturnType<typeof mapSupplier> | null = null;
  let error: string | null = null;
  try {
    mapped = mapSupplier(await erpReportsApi.report("suppliers", query));
  } catch (e) {
    error = e instanceof Error ? e.message : "Report request failed";
  }
  const period = String(query.period ?? "Last30Days");
  const comparisonMode = String(query.comparisonMode ?? "None");

  return (
    <main>
      <h1>Reports — suppliers</h1>
      <section>
        <h2>Filters</h2>
        <p>Period: {periodLabels[period] ?? period}; Comparison: {comparisonLabels[comparisonMode] ?? comparisonMode}</p>
        <ExportLinks reportType="suppliers" exportUrl={erpReportsApi.exportUrl} />
      </section>
      {error ? (
        <ReportError message={error} />
      ) : (
        <>
          <CompletenessWarnings warnings={mapped?.warnings ?? []} />
          <section>
            <h2>Suppliers</h2>
            {mapped?.suppliers?.length ? (
              <table>
                <thead><tr><th>Supplier</th><th>Purchases</th><th>Total Spend</th><th>Avg Landed Cost</th></tr></thead>
                <tbody>
                  {mapped.suppliers.map((s: any) => (
                    <tr key={s.id}>
                      <td>{s.maskedName}</td>
                      <td>{formatMetricValue("purchaseCount", s.purchaseCount)}</td>
                      <td>{formatMetricValue("totalSpend", s.totalSpend)}</td>
                      <td>{formatMetricValue("averageLandedCost", s.averageLandedCost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p>No suppliers were returned for this period.</p>
            )}
          </section>
        </>
      )}
    </main>
  );
}
