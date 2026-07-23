import { StandardReportBody, type ReportSearchParams } from "@/components/reports/ReportPage";
import { mapShipping } from "@/lib/erpReportsAnalyticsBridge";

export const dynamic = "force-dynamic";

export default function Page({ searchParams }: { searchParams: ReportSearchParams }) {
  return <StandardReportBody title="shipping" reportType="shipping" searchParams={searchParams} mapFn={mapShipping} />;
}
