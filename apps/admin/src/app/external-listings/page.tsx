export const dynamic = "force-dynamic";
import Link from "next/link";
import { listExternalListings } from "../../lib/marketplaceSync";
export default async function ExternalListingsPage({ searchParams }: { searchParams:Record<string,string> }){ const qs=new URLSearchParams(searchParams).toString(); const data=await listExternalListings(qs?`?${qs}`:""); return <main><h1>External Listings</h1><table><thead><tr><th>Channel</th><th>Status</th><th>Product</th><th>Last sync state</th><th>Manual sync</th></tr></thead><tbody>{data.items.map((l:any)=><tr key={l.id}><td>{l.channel}</td><td>{l.externalStatus}</td><td><Link href={`/products/${l.productId}`}>{l.productId}</Link></td><td>{l.updatedAt}</td><td>POST /api/external-listings/{l.id}/sync</td></tr>)}</tbody></table></main>; }
