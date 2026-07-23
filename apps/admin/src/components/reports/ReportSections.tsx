/**
 * Sprint 55B: shared presentational pieces for the ERP report pages, so the
 * 10+ near-identical report pages don't each duplicate metric/breakdown/
 * series rendering. Server-render-only (no client hooks) - safe to use
 * directly inside async Server Component pages.
 */

const MONEY_FIELD = /cost|value|spend|revenue|amount|profit|refunded|charged|outflow|movement|premium|shipping$|customs|packaging|miscellaneous|taxvat|subtotal/i;

export function formatMetricValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return "Incomplete";
  if (typeof value === "number") return MONEY_FIELD.test(key) ? `€${value.toFixed(2)}` : String(value);
  return String(value);
}

export function ReportError({ message }: { message: string }) {
  return <p role="alert" style={{ color: "var(--noctella-rust, #a33)" }}>Report data is currently unavailable: {message}</p>;
}

export function CompletenessWarnings({ warnings }: { warnings: string[] }) {
  if (!warnings?.length) return null;
  return (
    <ul role="status" style={{ color: "var(--noctella-aged-bronze)" }}>
      {warnings.map((w, i) => <li key={i}>{w}</li>)}
    </ul>
  );
}

export function MetricsGrid({ metrics }: { metrics: Record<string, unknown> }) {
  const entries = Object.entries(metrics ?? {});
  if (!entries.length) return <p>No metrics were returned for this period.</p>;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
      {entries.map(([key, value]) => (
        <div key={key} className="noctella-panel" style={{ padding: 12 }}>
          <p style={{ margin: 0, fontSize: 12, color: "var(--noctella-aged-bronze)" }}>{key}</p>
          <p style={{ margin: "4px 0 0", fontSize: 20 }}>{formatMetricValue(key, value)}</p>
        </div>
      ))}
    </div>
  );
}

interface BreakdownRow { dimension: string; key: string; label: string; metrics: Array<{ key: string; value: unknown }> }
export function BreakdownTable({ breakdowns }: { breakdowns: BreakdownRow[] }) {
  if (!breakdowns?.length) return <p>No breakdown data was returned for this period.</p>;
  const columns = Array.from(new Set(breakdowns.flatMap((b) => b.metrics.map((m) => m.key))));
  return (
    <table>
      <thead><tr><th>{breakdowns[0]?.dimension ?? "Group"}</th>{columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
      <tbody>
        {breakdowns.map((b) => (
          <tr key={`${b.dimension}-${b.key}`}>
            <td>{b.label}</td>
            {columns.map((c) => { const m = b.metrics.find((x) => x.key === c); return <td key={c}>{formatMetricValue(c, m?.value)}</td>; })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface SeriesPoint { label: string; value: unknown; comparison: unknown; changePercent: number | null }
export function SeriesTable({ series }: { series: SeriesPoint[] }) {
  if (!series?.length) return null;
  return (
    <table>
      <thead><tr><th>Period</th><th>Value</th><th>Comparison</th><th>Change %</th></tr></thead>
      <tbody>
        {series.map((p, i) => (
          <tr key={i}>
            <td>{p.label}</td>
            <td>{formatMetricValue("value", p.value)}</td>
            <td>{formatMetricValue("comparison", p.comparison)}</td>
            <td>{p.changePercent == null ? "Incomplete" : `${p.changePercent}%`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ExportLinks({ reportType, exportUrl }: { reportType: string; exportUrl: (t: string, f: "json" | "csv") => string }) {
  return (
    <p>
      <a href={exportUrl(reportType, "json")}>Export JSON</a> <a href={exportUrl(reportType, "csv")}>Export CSV</a>
    </p>
  );
}
