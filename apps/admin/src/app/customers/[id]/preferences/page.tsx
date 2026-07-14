export const dynamic = "force-dynamic";
import { customerApi } from "../../../../lib/erpCustomerBridge";
export default async function CustomerPreferencesPage({params}:{params:{id:string}}){ const p:any=await customerApi.preferences(params.id); return <main><h1>Customer Preferences</h1><p>Language: {p?.language ?? "Incomplete"}</p><p>Currency: {p?.currency ?? "Incomplete"}</p><p>Marketplace: {p?.preferredMarketplace ?? "Incomplete"}</p></main>; }
