import { NextResponse } from "next/server";
import { fetchErpBackend, warehouseEventsPath } from "@/lib/server/erpServerClient";

export async function GET(req: Request) {
  try {
    const query = new URL(req.url).searchParams.toString();
    const upstream = await fetchErpBackend(warehouseEventsPath(query));
    const body = await upstream.text();
    return new NextResponse(body, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return NextResponse.json({ error: "ERP backend is not configured" }, { status: 500 });
  }
}
