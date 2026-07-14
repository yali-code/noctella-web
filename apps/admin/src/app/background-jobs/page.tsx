export const dynamic = "force-dynamic";
import Link from "next/link";
import { listBackgroundJobs, safeError } from "../../lib/stockSyncJobs";
export default async function BackgroundJobsPage() { const { items } = await listBackgroundJobs(); return <main><h1>Background jobs</h1><p>Filter by status, type, channel, or product in the API query string.</p><table><tbody>{items.map((j) => <tr key={j.id}><td><Link href={`/background-jobs/${j.id}`}>{j.id}</Link></td><td>{j.type}</td><td>{j.status}</td><td>{j.channel}</td><td>{j.attemptCount}/{j.maxAttempts}</td><td>{j.runAfter}</td><td>{safeError(j.lastError)}</td></tr>)}</tbody></table></main>; }
