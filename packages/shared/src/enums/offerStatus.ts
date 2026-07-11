export enum OfferStatus {
  Pending = "pending",
  Accepted = "accepted",
  Rejected = "rejected",
  Expired = "expired",
}

export const OFFER_STATUS_VALUES: OfferStatus[] = Object.values(OfferStatus);
