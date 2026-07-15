const api = { get: async (path:string) => ({ path }) };
export type ReportQuery = Record<string, string | number | boolean | undefined | null>;
export function query(path:string, q:ReportQuery={}){ const sp=new URLSearchParams(); Object.entries(q).filter(([,v])=>v!==undefined&&v!==null&&v!=="").sort(([a],[b])=>a.localeCompare(b)).forEach(([k,v])=>sp.set(k,String(v))); return sp.size?`${path}?${sp}`:path; }
export const periodLabels:Record<string,string>={Today:"Today",Yesterday:"Yesterday",Last7Days:"Last 7 days",Last30Days:"Last 30 days",ThisMonth:"This month",PreviousMonth:"Previous month",ThisQuarter:"This quarter",PreviousQuarter:"Previous quarter",ThisYear:"This year",PreviousYear:"Previous year",Custom:"Custom"};
export const comparisonLabels:Record<string,string>={None:"No comparison",PreviousPeriod:"Previous period",PreviousYear:"Previous year"};
export const erpReportsApi={ dashboard:(q={})=>api.get(query("/erp/reports/dashboard",q)), report:(t:string,q={})=>api.get(query(`/erp/reports/${t}`,q)), exportUrl:(t:string,format:"json"|"csv",q={})=>query(`/erp/reports/${t}/export`,{...q,format}) };
export const mapMetric=(v:any,key:string)=>({key,value:v?.[key]??null,complete:v?.[key]!==null&&v?.[key]!==undefined});
export const mapDashboard=(r:any)=>({inventory:r?.inventory??{},purchasing:r?.purchasing??{},sales:r?.sales??{},returnsRefunds:r?.returnsRefunds??{},customers:r?.customers??{},warehouse:r?.warehouse??{},warnings:mapCompletenessWarnings(r)});
export const mapInventory=(r:any)=>({metrics:r?.metrics??{},breakdowns:mapBreakdowns(r),products:r?.products??[],warnings:mapCompletenessWarnings(r)});
export const mapPurchasing=(r:any)=>({metrics:r?.metrics??{},series:mapSeries(r),breakdowns:mapBreakdowns(r),warnings:mapCompletenessWarnings(r)});
export const mapSupplier=(r:any)=>({suppliers:r?.suppliers??[],supplier:r?.supplier??null,warnings:mapCompletenessWarnings(r)});
export const mapSalesChannel=(r:any)=>({metrics:r?.metrics??{},series:mapSeries(r),breakdowns:mapBreakdowns(r),channel:r?.channel});
export const mapFinance=(r:any)=>({metrics:r?.metrics??{},notice:r?.sections?.notice});
export const mapCustomer=(r:any)=>({metrics:r?.metrics??{},segments:r?.segments??{},customers:(r?.customers??[]).map(maskCustomerRow)});
export const mapReturnRefund=(r:any)=>({metrics:r?.metrics??{},breakdowns:mapBreakdowns(r)});
export const mapShipping=(r:any)=>({metrics:r?.metrics??{},breakdowns:mapBreakdowns(r)});
export const mapWarehouse=(r:any)=>({metrics:r?.metrics??{},breakdowns:mapBreakdowns(r)});
export const mapSeries=(r:any)=>(r?.series??[]).map((p:any)=>({label:p.period,value:p.value??null,comparison:p.comparisonValue??null,changePercent:p.changePercent??null}));
export const mapBreakdowns=(r:any)=>(r?.breakdowns??[]).map((b:any)=>({dimension:b.dimension,key:b.key,label:b.label,metrics:b.metrics??[]}));
export const mapCompletenessWarnings=(r:any)=>(r?.issues??[]).map((i:any)=>`${i.code}: ${i.message}`);
export function exportUrl(reportType:string,format:"json"|"csv",q:ReportQuery={}){ return erpReportsApi.exportUrl(reportType,format,q); }
export function redactSafeError(err:any){ const msg=String(err?.message??err??"Report request failed"); return msg.replace(/[A-Za-z0-9_-]{24,}/g,"[redacted]").replace(/[\w.+-]+@[\w.-]+/g,"[masked]"); }
export function maskCustomerRow(c:any){ return { ...c, email:undefined, phone:undefined, address:undefined, maskedEmail:c?.maskedEmail??(c?.email?`${String(c.email).slice(0,2)}***`:null) }; }
