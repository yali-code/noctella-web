import { NextResponse } from "next/server";
import { fetchErpBackend, productPurchaseHistoryPath } from "@/lib/server/erpServerClient";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const upstream = await fetchErpBackend(productPurchaseHistoryPath(params.id));
    return new NextResponse(await upstream.text(), {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return NextResponse.json({ error: "ERP backend is not configured" }, { status: 500 });
  }
}
