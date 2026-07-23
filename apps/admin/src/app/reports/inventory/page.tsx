import { StandardReportBody, type ReportSearchParams } from "@/components/reports/ReportPage";
import { mapInventory } from "@/lib/erpReportsAnalyticsBridge";

export const dynamic = "force-dynamic";

export default function Page({ searchParams }: { searchParams: ReportSearchParams }) {
  return <StandardReportBody title="inventory" reportType="inventory" searchParams={searchParams} mapFn={mapInventory} />;
}
