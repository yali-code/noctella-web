import { NextResponse } from "next/server";
import { fetchErpBackend, invoiceIntakeFilePath } from "@/lib/server/erpServerClient";

const STREAMED_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);

/** PHASE-2A: streams the stored invoice file through the admin origin; errors pass through as JSON. */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const upstream = await fetchErpBackend(invoiceIntakeFilePath(params.id));
    const contentType = upstream.headers.get("content-type") ?? "";
    if (!upstream.ok) {
      const text = await upstream.text();
      return new NextResponse(text, { status: upstream.status, headers: { "Content-Type": contentType || "application/json" } });
    }
    if (!upstream.body || !STREAMED_TYPES.has(contentType)) {
      await upstream.body?.cancel();
      return NextResponse.json({ error: "Invoice file could not be read" }, { status: 502 });
    }
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Content-Disposition": upstream.headers.get("content-disposition") ?? "inline",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    };
    const length = upstream.headers.get("content-length");
    if (length) headers["Content-Length"] = length;
    return new Response(upstream.body, { status: 200, headers });
  } catch {
    return NextResponse.json({ error: "ERP backend is not configured" }, { status: 500 });
  }
}
