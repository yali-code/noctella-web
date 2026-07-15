export enum ReportPeriod { Today="Today", Yesterday="Yesterday", Last7Days="Last7Days", Last30Days="Last30Days", ThisMonth="ThisMonth", PreviousMonth="PreviousMonth", ThisQuarter="ThisQuarter", PreviousQuarter="PreviousQuarter", ThisYear="ThisYear", PreviousYear="PreviousYear", Custom="Custom" }
export enum ReportGranularity { Day="Day", Week="Week", Month="Month", Quarter="Quarter", Year="Year" }
export enum ReportComparisonMode { None="None", PreviousPeriod="PreviousPeriod", PreviousYear="PreviousYear" }
export enum ReportCompleteness { Complete="Complete", Incomplete="Incomplete", Partial="Partial" }
export enum ReportExportFormat { Json="json", Csv="csv" }
export type ReportMetric = { key:string; label:string; value:number|null; currency?:"EUR"; completeness:ReportCompleteness; issueCodes?:string[] };
export type ReportSeriesPoint = { period:string; value:number|null; comparisonValue?:number|null; changePercent?:number|null };
export type ReportDimensionBreakdown = { dimension:string; key:string; label:string; metrics:ReportMetric[] };
export type ReportFilter = { period?:ReportPeriod|string; dateFrom?:string; dateTo?:string; granularity?:ReportGranularity|string; comparisonMode?:ReportComparisonMode|string; channel?:string; category?:string; collection?:string; brand?:string; supplier?:string; warehouse?:string; location?:string; country?:string; status?:string; product?:string; customer?:string; timezone?:string };
export type ErpReportIssue = { code:string; severity:"Info"|"Warning"|"Incomplete"; message:string; field?:string };
export type ErpReportBase = { reportType:string; generatedAt:string; currency:"EUR"; filters:ReportFilter; completeness:ReportCompleteness; issues:ErpReportIssue[]; timezone:{ requested:string; internal:"UTC" } };
export type ErpDashboardSummary = ErpReportBase & { inventory:any; purchasing:any; sales:any; returnsRefunds:any; customers:any; warehouse:any };
export type ErpInventoryReport = ErpReportBase & { metrics:Record<string,number|null>; breakdowns:ReportDimensionBreakdown[]; products:any[] };
export type ErpStockAgingReport = ErpReportBase & { buckets:ReportDimensionBreakdown[]; dateSources:string[] };
export type ErpPurchasingReport = ErpReportBase & { metrics:Record<string,number|null>; breakdowns:ReportDimensionBreakdown[]; series:ReportSeriesPoint[] };
export type ErpSupplierPerformanceReport = ErpReportBase & { suppliers:any[]; supplier?:any };
export type ErpSalesReport = ErpReportBase & { metrics:Record<string,number|null>; breakdowns:ReportDimensionBreakdown[]; series:ReportSeriesPoint[] };
export type ErpChannelPerformanceReport = ErpSalesReport & { channel?:string };
export type ErpFinanceReport = ErpReportBase & { metrics:Record<string,number|null>; sections?:Record<string,unknown> };
export type ErpProfitReport = ErpFinanceReport;
export type ErpCustomerReport = ErpReportBase & { metrics:Record<string,number|null>; segments?:Record<string,number>; customers?:any[]; customer?:any; breakdowns?:ReportDimensionBreakdown[] };
export type ErpReturnRefundReport = ErpReportBase & { metrics:Record<string,number|null>; breakdowns:ReportDimensionBreakdown[] };
export type ErpShippingReport = ErpReportBase & { metrics:Record<string,number|null>; breakdowns:ReportDimensionBreakdown[] };
export type ErpWarehouseReport = ErpReportBase & { metrics:Record<string,number|null>; breakdowns:ReportDimensionBreakdown[] };
export type ErpReportExport = ErpReportBase & { filename:string; format:ReportExportFormat|string; columns:string[]; rows:Record<string,unknown>[]; rowCount:number; rowLimit:number };
export type ErpReportCapabilities = { availableReports:string[]; supportedFilters:string[]; supportedPeriods:ReportPeriod[]; supportedGranularities:ReportGranularity[]; supportedComparisons:ReportComparisonMode[]; exportFormats:ReportExportFormat[]; maximumRangeDays:number; maximumExportRows:number; completenessBehavior:string; generatedAt:string };
