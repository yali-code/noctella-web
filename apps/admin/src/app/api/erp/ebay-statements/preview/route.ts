import { NextResponse } from "next/server";
import { postErpBackendMultipart } from "@/lib/server/erpServerClient";

/** Multipart pass-through; format and size checks stay in the backend. */
export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid report upload" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof Blob)) return NextResponse.json({ error: "A report file is required" }, { status: 400 });
  const forward = new FormData();
  forward.append("file", file, file instanceof File ? file.name : "report.csv");
  try {
    const upstream = await postErpBackendMultipart("/api/erp/ebay-statements/preview", forward);
    return new NextResponse(await upstream.text(), { status: upstream.status, headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" } });
  } catch {
    return NextResponse.json({ error: "ERP backend is not configured" }, { status: 500 });
  }
}
