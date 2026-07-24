export const dynamic = "force-dynamic";
import { customerApi, mapAnalytics } from "../../../../lib/erpCustomerBridge";
export default async function CustomerAnalyticsPage({params}:{params:{id:string}}){
  let stats: any = null;
  let error: string | null = null;
  try { stats = mapAnalytics(await customerApi.statistics(params.id)); } catch (err) { error = err instanceof Error ? err.message : "Failed to load customer analytics"; }
  if (error) return <main><h1>Customer Analytics</h1><p role="alert">{error}</p></main>;
  return <main><h1>Customer Analytics</h1><p>Lifetime value: {stats.lifetimeValue}</p><p>Order count: {stats.orderCount}</p><p>Average order value: {stats.averageOrderValue}</p><p>Customer score: {stats.customerScore}</p></main>;
}
