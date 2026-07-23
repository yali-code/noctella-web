import { StandardReportBody, type ReportSearchParams } from "@/components/reports/ReportPage";
import { mapSalesChannel } from "@/lib/erpReportsAnalyticsBridge";

export const dynamic = "force-dynamic";

export default function Page({ searchParams }: { searchParams: ReportSearchParams }) {
  return <StandardReportBody title="sales" reportType="sales" searchParams={searchParams} mapFn={mapSalesChannel} />;
}
