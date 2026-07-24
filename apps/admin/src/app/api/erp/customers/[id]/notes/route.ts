import { NextResponse } from "next/server";
import { customerNotesPath, fetchErpBackend } from "@/lib/server/erpServerClient";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const upstream = await fetchErpBackend(customerNotesPath(params.id));
    const body = await upstream.text();
    return new NextResponse(body, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return NextResponse.json({ error: "ERP backend is not configured" }, { status: 500 });
  }
}
