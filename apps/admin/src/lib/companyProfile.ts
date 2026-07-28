import { ApiError } from "./api";

async function erpGet<T>(path: string): Promise<T> {
  const res = await fetch(path);
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : undefined;
  if (!res.ok) throw new ApiError((body as any)?.error ?? res.statusText, res.status, (body as any)?.details);
  return body as T;
}
async function erpPost<T>(path: string, payload: unknown = {}): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload }),
  });
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : undefined;
  if (!res.ok) throw new ApiError((body as any)?.error ?? res.statusText, res.status, (body as any)?.details);
  return body as T;
}

export const companyProfileApi = {
  get: () => erpGet<any>(`/api/erp/company-profile`),
  update: (payload: any) => erpPost<any>(`/api/erp/commands/company-profile/update`, payload),
};

export const TAX_TREATMENT_OPTIONS = ["StandardVAT", "SecondHandMarginScheme", "IntraEUReverseCharge", "ExportZeroRated", "Manual"];
