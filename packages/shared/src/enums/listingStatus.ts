export enum ListingStatus {
  NotListed = "not_listed",
  Draft = "draft",
  Listed = "listed",
  PublishFailed = "publish_failed",
}

export const LISTING_STATUS_VALUES: ListingStatus[] = Object.values(ListingStatus);
