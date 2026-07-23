import { StandardReportBody, type ReportSearchParams } from "@/components/reports/ReportPage";
import { mapReturnRefund } from "@/lib/erpReportsAnalyticsBridge";

export const dynamic = "force-dynamic";

export default function Page({ searchParams }: { searchParams: ReportSearchParams }) {
  return <StandardReportBody title="returns-refunds" reportType="returns-refunds" searchParams={searchParams} mapFn={mapReturnRefund} />;
}
