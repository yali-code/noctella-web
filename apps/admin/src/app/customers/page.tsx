export const dynamic = "force-dynamic";
import { customerApi, mapCustomer } from "../../lib/erpCustomerBridge";
export default async function CustomersPage(){ const data:any=await customerApi.list(); return <main><h1>Customers</h1><p>CRM customer bridge. Noctella Web remains the single source of truth.</p><table><tbody>{(data.items??[]).map((r:any)=>{const c=mapCustomer(r); return <tr key={c.id}><td><a href={c.href}>{c.name}</a></td><td>{c.email}</td><td>{c.erpReferenceId}</td></tr>;})}</tbody></table><a href="/customers/merge">Customer Merge</a></main>; }
