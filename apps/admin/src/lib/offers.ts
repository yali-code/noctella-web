import { api } from "./api";
import type { Offer } from "@noctella/shared";

export const offersApi = {
  list: () => api.get<Offer[]>("/api/offers"),
  accept: (id: string) => api.post<Offer>(`/api/offers/${id}/accept`, {}),
  reject: (id: string) => api.post<Offer>(`/api/offers/${id}/reject`, {}),
};
