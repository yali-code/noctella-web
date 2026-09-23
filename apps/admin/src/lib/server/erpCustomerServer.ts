import "server-only";

import { ApiError } from "../api";
import { redactCustomerError } from "../erpCustomerBridge";
import {
  fetchErpBackend,
  customersListPath,
  customerPath,
  customerHistoryPath,
  customerStatisticsPath,
  customerPreferencesPath,
  customerNotesPath,
} from "./erpServerClient";

async function erpGet(path: string): Promise<any> {
  let res: Response;
  try {
    res = await fetchErpBackend(path);
  } catch {
    // Match the proxy's safe error response; never surface transport/configuration details.
    throw new ApiError("ERP backend is not configured", 500);
  }
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : undefined;
  if (!res.ok) throw new ApiError(redactCustomerError(body?.error ?? res.statusText), res.status, body?.details);
  return body;
}

export const customerApi = {
  list: (query = "") => erpGet(customersListPath(query)),
  detail: (id: string) => erpGet(customerPath(id)),
  history: (id: string) => erpGet(customerHistoryPath(id)),
  statistics: (id: string) => erpGet(customerStatisticsPath(id)),
  preferences: (id: string) => erpGet(customerPreferencesPath(id)),
  notes: (id: string) => erpGet(customerNotesPath(id)),
};
