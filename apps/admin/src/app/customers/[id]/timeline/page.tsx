export const dynamic = "force-dynamic";
import { customerApi, mapTimelineItem } from "../../../../lib/erpCustomerBridge";
export default async function CustomerTimelinePage({params}:{params:{id:string}}){
  let data: any = { items: [] };
  let error: string | null = null;
  try { data = await customerApi.history(params.id); } catch (err) { error = err instanceof Error ? err.message : "Failed to load customer timeline"; }
  return <main><h1>Customer Timeline</h1><p>Read-only timeline across orders, invoices, shipments, returns, refunds, notes, watchers, preferences, tags and audit events.</p>
    {error ? <p role="alert">{error}</p> : <ul>{(data.items??[]).map((r:any,i:number)=>{const item=mapTimelineItem(r); return <li key={i}>{item.when} — {item.label}</li>;})}</ul>}
  </main>;
}
