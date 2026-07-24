export const dynamic = "force-dynamic";
import { customerApi, mapCustomer } from "../../../lib/erpCustomerBridge";
export default async function CustomerDetailPage({params}:{params:{id:string}}){
  let row: any = null;
  let error: string | null = null;
  try { row = await customerApi.detail(params.id); } catch (err) { error = err instanceof Error ? err.message : "Failed to load customer"; }
  if (error) return <main><h1>Customer</h1><p role="alert">{error}</p></main>;
  const c=mapCustomer(row);
  return <main><h1>{c.name}</h1><p>Email: {c.email}</p><p>Phone: {c.phone}</p><nav><a href={`/customers/${params.id}/timeline`}>Timeline</a> <a href={`/customers/${params.id}/analytics`}>Analytics</a> <a href={`/customers/${params.id}/notes`}>Notes</a> <a href={`/customers/${params.id}/preferences`}>Preferences</a></nav></main>;
}
