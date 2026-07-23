import { StandardReportBody, type ReportSearchParams } from "@/components/reports/ReportPage";
import { mapFinance } from "@/lib/erpReportsAnalyticsBridge";

export const dynamic = "force-dynamic";

export default function Page({ searchParams }: { searchParams: ReportSearchParams }) {
  return <StandardReportBody title="finance" reportType="finance" searchParams={searchParams} mapFn={mapFinance} />;
}
