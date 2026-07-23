import { NextResponse } from "next/server";
import { createWarehouseLocationPath, postErpBackend } from "@/lib/server/erpServerClient";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const upstream = await postErpBackend(createWarehouseLocationPath(), body);
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return NextResponse.json({ error: "ERP backend is not configured" }, { status: 500 });
  }
}
