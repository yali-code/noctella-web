import { PublishChannel, type PublishReadinessSummary } from "@noctella/shared";
import { describe, expect, it } from "vitest";
import { issueMessages, publishChannelQuery, publishPayload, readinessByChannel } from "./publishing";

const summary: PublishReadinessSummary = {
  productId: "product-1",
  channels: [
    {
      channel: PublishChannel.Ebay,
      productId: "product-1",
      isReady: false,
      errors: [{ code: "missing", message: "Missing category" }],
      warnings: [{ code: "warn", message: "Missing subtitle" }],
    },
    {
      channel: PublishChannel.NoctellaWeb,
      productId: "product-1",
      isReady: true,
      errors: [],
      warnings: [],
    },
  ],
};

describe("admin publishing helpers", () => {
  it("builds channel payload and query values", () => {
    expect(publishPayload(PublishChannel.Etsy)).toEqual({ channel: PublishChannel.Etsy });
    expect(publishChannelQuery(PublishChannel.Ebay)).toBe("channel=ebay");
  });

  it("maps readiness by channel", () => {
    const mapped = readinessByChannel(summary);
    expect(mapped[PublishChannel.Ebay].isReady).toBe(false);
    expect(mapped[PublishChannel.NoctellaWeb].isReady).toBe(true);
  });

  it("maps errors and warnings to messages", () => {
    const ebay = readinessByChannel(summary)[PublishChannel.Ebay];
    expect(issueMessages(ebay, "errors")).toEqual(["Missing category"]);
    expect(issueMessages(ebay, "warnings")).toEqual(["Missing subtitle"]);
  });
});
