import { NextResponse } from "next/server";
import { fetchErpBackend } from "@/lib/server/erpServerClient";

export async function GET() {
  try {
    const upstream = await fetchErpBackend("/api/erp/ebay-statements/months");
    return new NextResponse(await upstream.text(), { status: upstream.status, headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" } });
  } catch {
    return NextResponse.json({ error: "ERP backend is not configured" }, { status: 500 });
  }
}
