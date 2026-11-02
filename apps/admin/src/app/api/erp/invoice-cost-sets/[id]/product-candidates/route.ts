import { NextResponse } from "next/server";
import { fetchErpBackend, invoiceCostSetProductCandidatesPath } from "@/lib/server/erpServerClient";

/** PHASE-2C: only the search term is forwarded. */
export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const q = new URL(req.url).searchParams.get("q") ?? "";
    const upstream = await fetchErpBackend(invoiceCostSetProductCandidatesPath(params.id, q ? new URLSearchParams({ q }).toString() : ""));
    const body = await upstream.text();
    return new NextResponse(body, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return NextResponse.json({ error: "ERP backend is not configured" }, { status: 500 });
  }
}
