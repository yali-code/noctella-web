export const dynamic = "force-dynamic";
import Link from "next/link";
import { getConflict, listingLink, productLink, safeError } from "../../../../lib/stockSyncJobs";
export default async function ConflictDetail({ params }: { params: { id: string } }) { const c = await getConflict(params.id); return <main><h1>Conflict {c.id}</h1><dl><dt>Type</dt><dd>{c.conflictType}</dd><dt>Status</dt><dd>{c.status}</dd><dt>Product</dt><dd><Link href={productLink(c.productId)}>{c.productId}</Link></dd><dt>Listing</dt><dd><Link href={listingLink(c.externalListingId)}>{c.externalListingId}</Link></dd><dt>Stock</dt><dd>{c.localStock} / {c.marketplaceStock}</dd><dt>Resolution</dt><dd>{c.resolution ?? "-"}</dd></dl><pre>{safeError(c.detailsSnapshot)}</pre></main>; }
