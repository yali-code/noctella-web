export const dynamic = "force-dynamic";
import { customerApi, mapAnalytics } from "../../../../lib/erpCustomerBridge";
export default async function CustomerAnalyticsPage({params}:{params:{id:string}}){ const stats:any=mapAnalytics(await customerApi.statistics(params.id)); return <main><h1>Customer Analytics</h1><p>Lifetime value: {stats.lifetimeValue}</p><p>Order count: {stats.orderCount}</p><p>Average order value: {stats.averageOrderValue}</p><p>Customer score: {stats.customerScore}</p></main>; }
