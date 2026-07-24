export const dynamic = "force-dynamic";
import { customerApi } from "../../../../lib/erpCustomerBridge";
export default async function CustomerPreferencesPage({params}:{params:{id:string}}){
  let p: any = null;
  let error: string | null = null;
  try { p = await customerApi.preferences(params.id); } catch (err) { error = err instanceof Error ? err.message : "Failed to load customer preferences"; }
  if (error) return <main><h1>Customer Preferences</h1><p role="alert">{error}</p></main>;
  return <main><h1>Customer Preferences</h1><p>Language: {p?.language ?? "Incomplete"}</p><p>Currency: {p?.currency ?? "Incomplete"}</p><p>Marketplace: {p?.preferredMarketplace ?? "Incomplete"}</p></main>;
}
