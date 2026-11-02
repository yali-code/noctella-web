import { NextResponse } from "next/server";
import { invoiceCostSetPreviewPath, postErpBackend } from "@/lib/server/erpServerClient";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  try {
    const upstream = await postErpBackend(invoiceCostSetPreviewPath(params.id), {});
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return NextResponse.json({ error: "ERP backend is not configured" }, { status: 500 });
  }
}
