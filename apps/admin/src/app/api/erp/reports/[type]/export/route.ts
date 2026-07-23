import { NextResponse } from "next/server";
import { fetchErpBackend } from "@/lib/server/erpServerClient";

/**
 * Sprint 55B: same-origin proxy for report CSV/JSON export links, mirroring
 * the existing invoice-command proxy pattern (Sprint 42A). Export links are
 * plain browser-clickable <a href> navigations, which cannot carry the ERP
 * key header themselves, so this route injects it server-side and forwards
 * the upstream response (including Content-Disposition, needed for the CSV
 * download filename) back to the browser unchanged.
 */
export async function GET(req: Request, { params }: { params: { type: string } }) {
  try {
    const { search } = new URL(req.url);
    const upstream = await fetchErpBackend(`/api/erp/reports/${encodeURIComponent(params.type)}/export${search}`);
    const body = await upstream.text();
    const headers: Record<string, string> = { "Content-Type": upstream.headers.get("content-type") ?? "application/json" };
    const disposition = upstream.headers.get("content-disposition");
    if (disposition) headers["Content-Disposition"] = disposition;
    return new NextResponse(body, { status: upstream.status, headers });
  } catch {
    return NextResponse.json({ error: "ERP backend is not configured" }, { status: 500 });
  }
}
