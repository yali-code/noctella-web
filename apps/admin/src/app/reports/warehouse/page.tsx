import { StandardReportBody, type ReportSearchParams } from "@/components/reports/ReportPage";
import { mapWarehouse } from "@/lib/erpReportsAnalyticsBridge";

export const dynamic = "force-dynamic";

export default function Page({ searchParams }: { searchParams: ReportSearchParams }) {
  return <StandardReportBody title="warehouse" reportType="warehouse" searchParams={searchParams} mapFn={mapWarehouse} />;
}
