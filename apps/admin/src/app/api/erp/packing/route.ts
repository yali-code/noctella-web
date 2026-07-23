import { NextResponse } from "next/server";
import { fetchErpBackend, packingListPath } from "@/lib/server/erpServerClient";

export async function GET(req: Request) {
  try {
    const query = new URL(req.url).searchParams.toString();
    const upstream = await fetchErpBackend(packingListPath(query));
    const body = await upstream.text();
    return new NextResponse(body, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return NextResponse.json({ error: "ERP backend is not configured" }, { status: 500 });
  }
}
