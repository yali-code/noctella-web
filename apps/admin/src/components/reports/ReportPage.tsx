import { erpReportsApi, periodLabels, comparisonLabels } from "@/lib/erpReportsAnalyticsBridge";
import { CompletenessWarnings, MetricsGrid, BreakdownTable, SeriesTable, ExportLinks, ReportError } from "./ReportSections";

export type ReportSearchParams = Record<string, string | string[] | undefined>;

interface StandardReportShape {
  metrics: Record<string, unknown>;
  breakdowns?: Array<{ dimension: string; key: string; label: string; metrics: Array<{ key: string; value: unknown }> }>;
  series?: Array<{ label: string; value: unknown; comparison: unknown; changePercent: number | null }>;
  warnings?: string[];
  notice?: string;
}

function flatQuery(searchParams: ReportSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(searchParams)) if (typeof v === "string") out[k] = v;
  return out;
}

/**
 * Sprint 55B: shared body for the report pages that share the backend's
 * {metrics, breakdowns?, series?, warnings?} shape (inventory, purchasing,
 * sales, channels, finance, returns-refunds, shipping, warehouse). Suppliers
 * and customers return a genuinely different shape (lists, not metrics) and
 * are rendered by their own page components instead of this shared body.
 */
export async function StandardReportBody({
  title, reportType, searchParams, mapFn,
}: {
  title: string;
  reportType: string;
  searchParams: ReportSearchParams;
  mapFn: (r: any) => StandardReportShape;
}) {
  const query = flatQuery(searchParams);
  let mapped: StandardReportShape | null = null;
  let error: string | null = null;
  try {
    mapped = mapFn(await erpReportsApi.report(reportType, query));
  } catch (e) {
    error = e instanceof Error ? e.message : "Report request failed";
  }
  const period = query.period ?? "Last30Days";
  const comparisonMode = query.comparisonMode ?? "None";

  return (
    <main>
      <h1>Reports — {title}</h1>
      <section>
        <h2>Filters</h2>
        <p>Period: {periodLabels[period] ?? period}; Comparison: {comparisonLabels[comparisonMode] ?? comparisonMode}</p>
        <ExportLinks reportType={reportType} exportUrl={erpReportsApi.exportUrl} />
      </section>
      {error ? (
        <ReportError message={error} />
      ) : (
        <>
          <CompletenessWarnings warnings={mapped?.warnings ?? []} />
          <section>
            <h2>Summary cards</h2>
            <MetricsGrid metrics={mapped?.metrics ?? {}} />
            {mapped?.notice ? <p>{mapped.notice}</p> : null}
          </section>
          {mapped?.breakdowns ? (
            <section>
              <h2>Breakdown</h2>
              <BreakdownTable breakdowns={mapped.breakdowns} />
            </section>
          ) : null}
          {mapped?.series ? (
            <section>
              <h2>Time series</h2>
              <SeriesTable series={mapped.series} />
            </section>
          ) : null}
        </>
      )}
    </main>
  );
}
