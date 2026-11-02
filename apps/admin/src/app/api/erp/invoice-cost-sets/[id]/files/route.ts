import { NextResponse } from "next/server";
import { invoiceCostSetFilesPath, postErpBackendMultipart } from "@/lib/server/erpServerClient";

/**
 * PHASE-2A: multipart pass-through. Only the `file` and `invoiceType` fields are rebuilt into a fresh
 * FormData; format, size and page checks stay in the backend guard.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid invoice upload" }, { status: 400 });
  }
  const file = form.get("file");
  const invoiceType = form.get("invoiceType");
  if (!(file instanceof Blob)) return NextResponse.json({ error: "An invoice file is required" }, { status: 400 });
  const forward = new FormData();
  forward.append("invoiceType", typeof invoiceType === "string" ? invoiceType : "");
  forward.append("file", file, file instanceof File ? file.name : "invoice");
  try {
    const upstream = await postErpBackendMultipart(invoiceCostSetFilesPath(params.id), forward);
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return NextResponse.json({ error: "ERP backend is not configured" }, { status: 500 });
  }
}
