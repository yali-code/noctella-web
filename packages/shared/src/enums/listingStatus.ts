export enum ListingStatus {
  Draft = "draft",
  Ready = "ready",
  Published = "published",
  Ended = "ended",
  Archived = "archived",
  Error = "error",
  NotListed = "not_listed",
  Listed = "listed",
}

export const LISTING_STATUS_VALUES: ListingStatus[] = Object.values(ListingStatus);
