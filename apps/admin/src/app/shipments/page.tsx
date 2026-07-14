import Link from "next/link";
import { listShipments, safeErrorSummary, shipmentOrderLink } from "../../lib/shipments";
export default async function ShipmentsPage({ searchParams }: { searchParams?: Record<string,string> }) {
  const shipments = await listShipments(searchParams ?? {}).catch(() => []);
  return <main><h1>Shipments</h1><form><input name="orderId" placeholder="Order ID"/><input name="status" placeholder="Status"/><input name="channel" placeholder="Channel"/><input name="carrier" placeholder="Carrier"/><input name="trackingNumber" placeholder="Tracking"/><button>Filter</button></form><table><thead><tr><th>Order</th><th>Channel</th><th>Carrier</th><th>Tracking</th><th>Status</th><th>Shipped</th><th>Delivered</th><th>Error</th></tr></thead><tbody>{shipments.map((s)=><tr key={s.id}><td><Link href={shipmentOrderLink(s)}>{s.orderId}</Link></td><td>{s.channel ?? "internal"}</td><td>{s.carrierCode}</td><td><Link href={`/shipments/${s.id}`}>{s.trackingNumber ?? "—"}</Link></td><td>{s.status}</td><td>{s.shippedAt ?? "—"}</td><td>{s.deliveredAt ?? "—"}</td><td>{safeErrorSummary(s.lastError)}</td></tr>)}</tbody></table></main>;
}
