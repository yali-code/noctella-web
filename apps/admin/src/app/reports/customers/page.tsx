import { erpReportsApi, mapCustomer, periodLabels, comparisonLabels, type ReportQuery } from "@/lib/erpReportsAnalyticsBridge";
import { CompletenessWarnings, ExportLinks, ReportError, MetricsGrid, formatMetricValue } from "@/components/reports/ReportSections";

export const dynamic = "force-dynamic";

function flatQuery(searchParams: Record<string, string | string[] | undefined>): ReportQuery {
  const out: ReportQuery = {};
  for (const [k, v] of Object.entries(searchParams)) if (typeof v === "string") out[k] = v;
  return out;
}

export default async function Page({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const query = flatQuery(searchParams);
  let mapped: ReturnType<typeof mapCustomer> | null = null;
  let error: string | null = null;
  try {
    mapped = mapCustomer(await erpReportsApi.report("customers", query));
  } catch (e) {
    error = e instanceof Error ? e.message : "Report request failed";
  }
  const period = String(query.period ?? "Last30Days");
  const comparisonMode = String(query.comparisonMode ?? "None");

  return (
    <main>
      <h1>Reports — customers</h1>
      <section>
        <h2>Filters</h2>
        <p>Period: {periodLabels[period] ?? period}; Comparison: {comparisonLabels[comparisonMode] ?? comparisonMode}</p>
        <ExportLinks reportType="customers" exportUrl={erpReportsApi.exportUrl} />
      </section>
      {error ? (
        <ReportError message={error} />
      ) : (
        <>
          <section>
            <h2>Summary cards</h2>
            <MetricsGrid metrics={mapped?.metrics ?? {}} />
          </section>
          <section>
            <h2>Segments</h2>
            {mapped?.segments && Object.keys(mapped.segments).length ? (
              <table>
                <thead><tr><th>Segment</th><th>Count</th></tr></thead>
                <tbody>{Object.entries(mapped.segments).map(([k, v]) => <tr key={k}><td>{k}</td><td>{formatMetricValue("count", v)}</td></tr>)}</tbody>
              </table>
            ) : (
              <p>No segment data was returned for this period.</p>
            )}
          </section>
          <section>
            <h2>Customers</h2>
            {mapped?.customers?.length ? (
              <table>
                <thead><tr><th>Email</th><th>Country</th></tr></thead>
                <tbody>{mapped.customers.map((c: any) => <tr key={c.id}><td>{c.maskedEmail ?? "—"}</td><td>{c.countryCode ?? "—"}</td></tr>)}</tbody>
              </table>
            ) : (
              <p>No customers were returned for this period.</p>
            )}
          </section>
        </>
      )}
    </main>
  );
}
