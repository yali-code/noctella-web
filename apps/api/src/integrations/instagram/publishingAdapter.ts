import { InstagramClient } from "./InstagramClient";
import { InstagramClientError } from "./types";
import { prepareInstagramImage } from "./mediaPreparation";
import { productPhotoStaticPath } from "../../services/photoStorage";
import { validateInstagramMediaUrl } from "../../config/instagramConfig";

/** Publishing asset preparation and provider operations; the service owns durable state and idempotency. */
export class InstagramPublishingAdapter {
  constructor(private readonly client: InstagramClient, private readonly pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), private readonly env: NodeJS.ProcessEnv = process.env) {}

  async createImageContainer(accountId: string, imageUrl: string, caption: string) {
    const validated = validateInstagramMediaUrl(imageUrl, this.env);
    const url = new URL(imageUrl);
    const rawPath = imageUrl.match(/^https:\/\/[^/]+(\/[^?#]*)/i)?.[1] ?? "";
    if (/\.webp$/i.test(rawPath) || /\.webp$/i.test(url.pathname)) {
      // Preserve the raw path for traversal checks instead of URL's normalized pathname.
      if (!rawPath.startsWith(`${productPhotoStaticPath}/`)) throw new InstagramClientError("invalid_media", false);
      imageUrl = await prepareInstagramImage({ url: rawPath }, url.origin, this.env);
    } else {
      imageUrl = validated;
    }
    return this.client.createImageContainer(accountId, imageUrl, caption);
  }

  async waitForReady(containerId: string): Promise<boolean> {
    for (let check = 0; check < 5; check += 1) {
      const status = await this.client.getContainerStatus(containerId);
      if (status === "FINISHED") return true;
      if (status === "ERROR" || status === "EXPIRED") throw new InstagramClientError("invalid_media", false);
      if (status !== "IN_PROGRESS" && status !== "PUBLISHED") throw new InstagramClientError("processing", false);
      if (status === "PUBLISHED") throw new InstagramClientError("processing", false);
      if (check < 4) await this.pause(1000);
    }
    return false;
  }

  publishContainer(accountId: string, containerId: string) {
    return this.client.publishContainer(accountId, containerId);
  }
}
