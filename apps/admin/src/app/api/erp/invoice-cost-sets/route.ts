import { NextResponse } from "next/server";
import { fetchErpBackend, invoiceCostSetsListPath, postErpBackend } from "@/lib/server/erpServerClient";

export async function GET(req: Request) {
  try {
    const query = new URL(req.url).searchParams.toString();
    const upstream = await fetchErpBackend(invoiceCostSetsListPath(query));
    const body = await upstream.text();
    return new NextResponse(body, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return NextResponse.json({ error: "ERP backend is not configured" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const upstream = await postErpBackend(invoiceCostSetsListPath(""), body);
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return NextResponse.json({ error: "ERP backend is not configured" }, { status: 500 });
  }
}
