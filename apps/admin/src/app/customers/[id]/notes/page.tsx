export const dynamic = "force-dynamic";
import { customerApi } from "../../../../lib/erpCustomerBridge";
export default async function CustomerNotesPage({params}:{params:{id:string}}){ const data:any=await customerApi.notes(params.id); return <main><h1>Customer Notes</h1><p>Notes are archived instead of deleted and masked unless explicitly revealed by the API.</p><ul>{(data.items??[]).map((n:any)=><li key={n.id}>v{n.version}: {n.body}</li>)}</ul></main>; }
