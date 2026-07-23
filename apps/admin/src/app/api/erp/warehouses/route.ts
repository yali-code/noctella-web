import { NextResponse } from "next/server";
import { fetchErpBackend, warehousesListPath } from "@/lib/server/erpServerClient";

export async function GET() {
  try {
    const upstream = await fetchErpBackend(warehousesListPath());
    const body = await upstream.text();
    return new NextResponse(body, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return NextResponse.json({ error: "ERP backend is not configured" }, { status: 500 });
  }
}
