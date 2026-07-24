export const dynamic = "force-dynamic";
import { customerApi } from "../../../../lib/erpCustomerBridge";
export default async function CustomerNotesPage({params}:{params:{id:string}}){
  let data: any = { items: [] };
  let error: string | null = null;
  try { data = await customerApi.notes(params.id); } catch (err) { error = err instanceof Error ? err.message : "Failed to load customer notes"; }
  return <main><h1>Customer Notes</h1><p>Notes are archived instead of deleted and masked unless explicitly revealed by the API.</p>
    {error ? <p role="alert">{error}</p> : <ul>{(data.items??[]).map((n:any)=><li key={n.id}>v{n.version}: {n.body}</li>)}</ul>}
  </main>;
}
