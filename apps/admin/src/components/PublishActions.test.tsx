// @vitest-environment jsdom
// Sprint 146: isolated component-level tests for the canonical publish surface - channel
// selection, the clean/dirty Save-before-Publish sequence (saveForPublish/onProductRefreshed are
// passed in directly as mocks here, exactly as ProductForm supplies them in production - the
// ProductForm-owned end-to-end wiring of those two callbacks is covered separately in
// ProductForm.test.tsx), per-channel truthful result rendering, connection guidance, and
// selected-channel validation display.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PublishChannel } from "@noctella/shared";
import { ApiError } from "@/lib/api";
import * as apiLib from "@/lib/api";
import * as publishingLib from "@/lib/publishing";
import * as marketplacesLib from "@/lib/marketplaces";
import { PublishActions } from "./PublishActions";

afterEach(() => vi.restoreAllMocks());

function validPreview(channel: PublishChannel) {
  return { productId: "p1", channel, validation: { productId: "p1", channel, valid: true, errors: [], warnings: [] } };
}

function invalidPreview(channel: PublishChannel, message = "A valid positive EUR price is required before publishing") {
  return {
    productId: "p1",
    channel,
    validation: { productId: "p1", channel, valid: false, errors: [{ field: "priceEur", severity: "error", message }], warnings: [] },
  };
}

function product(overrides: Record<string, unknown> = {}) {
  return { id: "p1", sku: "SKU-1", title: "Test", status: "draft", updatedAt: "2026-02-01T00:00:00.000Z", photos: [], images: [], marketplaceReadiness: {}, ...overrides } as any;
}

beforeEach(() => {
  vi.spyOn(publishingLib.publishingApi, "getPreview").mockImplementation(async (_id, channel) => validPreview(channel) as any);
  vi.spyOn(marketplacesLib.marketplaceApi, "listConnections").mockResolvedValue([]);
});

function alwaysOkSave(updatedAt = "2026-02-05T00:00:00.000Z") {
  return vi.fn().mockResolvedValue({ ok: true, updatedAt });
}

describe("PublishActions — channel selection", () => {
  it("blocks archived publishing without saving or batching",async()=>{const save=alwaysOkSave(),batch=vi.spyOn(marketplacesLib.marketplaceApi,"executePublishBatch");render(<PublishActions productId="p1" isDirty archived currentProductUpdatedAt="v" saveForPublish={save} onProductRefreshed={vi.fn()}/>);await userEvent.click(await screen.findByRole("checkbox",{name:"eBay"}));expect(screen.getByRole("button",{name:"Publish Selected"})).toBeDisabled();expect(screen.getByText("This Product is archived and cannot be published.")).toBeInTheDocument();expect(save).not.toHaveBeenCalled();expect(batch).not.toHaveBeenCalled()});
  it("blocks paused publishing without saving or batching",async()=>{const save=alwaysOkSave(),batch=vi.spyOn(marketplacesLib.marketplaceApi,"executePublishBatch");render(<PublishActions productId="p1" isDirty paused currentProductUpdatedAt="v" saveForPublish={save} onProductRefreshed={vi.fn()}/>);await userEvent.click(await screen.findByRole("checkbox",{name:"eBay"}));expect(screen.getByRole("button",{name:"Publish Selected"})).toBeDisabled();expect(save).not.toHaveBeenCalled();expect(batch).not.toHaveBeenCalled()});
  it("renders exactly one checkbox each for eBay, Etsy, and Noctella Web", async () => {
    render(<PublishActions productId="p1" isDirty={false} currentProductUpdatedAt="t" saveForPublish={alwaysOkSave()} onProductRefreshed={vi.fn()} />);
    expect(await screen.findByRole("checkbox", { name: "eBay" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Etsy" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Noctella Web" })).toBeInTheDocument();
  });

  it("Publish Selected is disabled when no channel is selected", async () => {
    render(<PublishActions productId="p1" isDirty={false} currentProductUpdatedAt="t" saveForPublish={alwaysOkSave()} onProductRefreshed={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Publish Selected" })).toBeDisabled();
  });

  it("selecting a channel enables Publish Selected", async () => {
    const user = userEvent.setup();
    render(<PublishActions productId="p1" isDirty={false} currentProductUpdatedAt="t" saveForPublish={alwaysOkSave()} onProductRefreshed={vi.fn()} />);
    await user.click(await screen.findByRole("checkbox", { name: "eBay" }));
    expect(screen.getByRole("button", { name: "Publish Selected" })).toBeEnabled();
  });

  it("no separate per-channel Publish buttons exist - only one Publish Selected action", async () => {
    render(<PublishActions productId="p1" isDirty={false} currentProductUpdatedAt="t" saveForPublish={alwaysOkSave()} onProductRefreshed={vi.fn()} />);
    await screen.findByRole("checkbox", { name: "eBay" });
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName("Publish Selected");
    expect(screen.queryByRole("button", { name: /publish to ebay/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /publish to etsy/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /publish to noctella web/i })).not.toBeInTheDocument();
  });

  it("Publish Selected is a type=button action - clicking it never submits a surrounding <form>", async () => {
    const user = userEvent.setup();
    const executeBatchSpy = vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch").mockResolvedValue({ productId: "p1", results: [] } as any);
    vi.spyOn(apiLib.api, "get").mockResolvedValue(product());
    const formSubmit = vi.fn((e: Event) => e.preventDefault());
    render(
      // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
      <form onSubmit={formSubmit as any}>
        <PublishActions productId="p1" isDirty={false} currentProductUpdatedAt="t" saveForPublish={alwaysOkSave()} onProductRefreshed={vi.fn()} />
      </form>,
    );
    await user.click(await screen.findByRole("checkbox", { name: "eBay" }));
    await user.click(screen.getByRole("button", { name: "Publish Selected" }));
    await waitFor(() => expect(executeBatchSpy).toHaveBeenCalled());
    expect(formSubmit).not.toHaveBeenCalled();
  });
});

describe("PublishActions — Save-before-Publish sequence", () => {
  it("clean Product (isDirty=false): does NOT call saveForPublish, and sends the current expectedUpdatedAt directly", async () => {
    const user = userEvent.setup();
    const saveForPublish = alwaysOkSave();
    const executeBatchSpy = vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch").mockResolvedValue({ productId: "p1", results: [] } as any);
    vi.spyOn(apiLib.api, "get").mockResolvedValue(product());
    render(<PublishActions productId="p1" isDirty={false} currentProductUpdatedAt="clean-version" saveForPublish={saveForPublish} onProductRefreshed={vi.fn()} />);
    await user.click(await screen.findByRole("checkbox", { name: "eBay" }));
    await user.click(screen.getByRole("button", { name: "Publish Selected" }));
    await waitFor(() => expect(executeBatchSpy).toHaveBeenCalledWith("p1", [PublishChannel.Ebay], "clean-version"));
    expect(saveForPublish).not.toHaveBeenCalled();
  });

  it("dirty Product (isDirty=true): calls saveForPublish BEFORE executePublishBatch, and uses the RETURNED updatedAt (not the stale prop) as the batch's expectedUpdatedAt", async () => {
    const user = userEvent.setup();
    const callOrder: string[] = [];
    const saveForPublish = vi.fn(async () => {
      callOrder.push("save");
      return { ok: true as const, updatedAt: "fresh-post-save-version" };
    });
    const executeBatchSpy = vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch").mockImplementation(async () => {
      callOrder.push("batch");
      return { productId: "p1", results: [] } as any;
    });
    vi.spyOn(apiLib.api, "get").mockResolvedValue(product());
    render(<PublishActions productId="p1" isDirty={true} currentProductUpdatedAt="stale-prop-version" saveForPublish={saveForPublish} onProductRefreshed={vi.fn()} />);
    await user.click(await screen.findByRole("checkbox", { name: "eBay" }));
    await user.click(screen.getByRole("button", { name: "Publish Selected" }));
    await waitFor(() => expect(executeBatchSpy).toHaveBeenCalled());
    expect(saveForPublish).toHaveBeenCalledTimes(1);
    expect(executeBatchSpy).toHaveBeenCalledWith("p1", [PublishChannel.Ebay], "fresh-post-save-version");
    expect(callOrder).toEqual(["save", "batch"]); // save happens strictly before the batch call
  });

  it("a failed Save (ok: false) NEVER calls executePublishBatch", async () => {
    const user = userEvent.setup();
    const saveForPublish = vi.fn().mockResolvedValue({ ok: false });
    const executeBatchSpy = vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch");
    render(<PublishActions productId="p1" isDirty={true} currentProductUpdatedAt="t" saveForPublish={saveForPublish} onProductRefreshed={vi.fn()} />);
    await user.click(await screen.findByRole("checkbox", { name: "eBay" }));
    await user.click(screen.getByRole("button", { name: "Publish Selected" }));
    await waitFor(() => expect(saveForPublish).toHaveBeenCalled());
    expect(executeBatchSpy).not.toHaveBeenCalled();
  });

  it("sends expectedUpdatedAt on every Publish Selected call, even when the Product was already clean", async () => {
    const user = userEvent.setup();
    const executeBatchSpy = vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch").mockResolvedValue({ productId: "p1", results: [] } as any);
    vi.spyOn(apiLib.api, "get").mockResolvedValue(product());
    render(<PublishActions productId="p1" isDirty={false} currentProductUpdatedAt="already-current" saveForPublish={alwaysOkSave()} onProductRefreshed={vi.fn()} />);
    await user.click(await screen.findByRole("checkbox", { name: "Etsy" }));
    await user.click(screen.getByRole("button", { name: "Publish Selected" }));
    await waitFor(() => expect(executeBatchSpy).toHaveBeenCalledWith("p1", [PublishChannel.Etsy], "already-current"));
  });
});

describe("PublishActions — channel selection sent to executePublishBatch", () => {
  it("selecting only eBay sends a one-element channel array", async () => {
    const user = userEvent.setup();
    const executeBatchSpy = vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch").mockResolvedValue({ productId: "p1", results: [] } as any);
    vi.spyOn(apiLib.api, "get").mockResolvedValue(product());
    render(<PublishActions productId="p1" isDirty={false} currentProductUpdatedAt="t" saveForPublish={alwaysOkSave()} onProductRefreshed={vi.fn()} />);
    await user.click(await screen.findByRole("checkbox", { name: "eBay" }));
    await user.click(screen.getByRole("button", { name: "Publish Selected" }));
    await waitFor(() => expect(executeBatchSpy).toHaveBeenCalledWith("p1", [PublishChannel.Ebay], "t"));
  });

  it("selecting multiple channels sends exactly one batch request with all selected channels", async () => {
    const user = userEvent.setup();
    const executeBatchSpy = vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch").mockResolvedValue({ productId: "p1", results: [] } as any);
    vi.spyOn(apiLib.api, "get").mockResolvedValue(product());
    render(<PublishActions productId="p1" isDirty={false} currentProductUpdatedAt="t" saveForPublish={alwaysOkSave()} onProductRefreshed={vi.fn()} />);
    await user.click(await screen.findByRole("checkbox", { name: "eBay" }));
    await user.click(screen.getByRole("checkbox", { name: "Etsy" }));
    await user.click(screen.getByRole("button", { name: "Publish Selected" }));
    await waitFor(() => expect(executeBatchSpy).toHaveBeenCalledTimes(1));
    expect(executeBatchSpy).toHaveBeenCalledWith("p1", [PublishChannel.Ebay, PublishChannel.Etsy], "t");
  });
});

describe("PublishActions — truthful per-channel result rendering", () => {
  it("renders partial success independently per channel - never a flattened generic message", async () => {
    const user = userEvent.setup();
    vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch").mockResolvedValue({
      productId: "p1",
      results: [
        { channel: PublishChannel.NoctellaWeb, outcome: "succeeded", result: {} as any },
        { channel: PublishChannel.Ebay, outcome: "failed", error: { message: "Marketplace connection is not connected" } },
      ],
    } as any);
    vi.spyOn(apiLib.api, "get").mockResolvedValue(product());
    render(<PublishActions productId="p1" isDirty={false} currentProductUpdatedAt="t" saveForPublish={alwaysOkSave()} onProductRefreshed={vi.fn()} />);
    await user.click(await screen.findByRole("checkbox", { name: "Noctella Web" }));
    await user.click(screen.getByRole("checkbox", { name: "eBay" }));
    await user.click(screen.getByRole("button", { name: "Publish Selected" }));
    expect(await screen.findByText(/Noctella Web — Published/)).toBeInTheDocument();
    expect(screen.getByText(/eBay — Failed: Marketplace connection is not connected/)).toBeInTheDocument();
  });

  it("renders a skipped result distinctly from success and failure", async () => {
    const user = userEvent.setup();
    vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch").mockResolvedValue({
      productId: "p1",
      results: [{ channel: PublishChannel.Ebay, outcome: "skipped", error: { message: "An active listing already exists for this product on this channel" } }],
    } as any);
    vi.spyOn(apiLib.api, "get").mockResolvedValue(product());
    render(<PublishActions productId="p1" isDirty={false} currentProductUpdatedAt="t" saveForPublish={alwaysOkSave()} onProductRefreshed={vi.fn()} />);
    await user.click(await screen.findByRole("checkbox", { name: "eBay" }));
    await user.click(screen.getByRole("button", { name: "Publish Selected" }));
    expect(await screen.findByText(/eBay — Already published/)).toBeInTheDocument();
  });

  it("a whole-batch error (e.g. version conflict) is surfaced locally without crashing", async () => {
    const user = userEvent.setup();
    vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch").mockRejectedValue(
      new ApiError("This product changed after you opened it. Reload the latest version before saving again.", 409, undefined, "PRODUCT_VERSION_CONFLICT"),
    );
    render(<PublishActions productId="p1" isDirty={false} currentProductUpdatedAt="t" saveForPublish={alwaysOkSave()} onProductRefreshed={vi.fn()} />);
    await user.click(await screen.findByRole("checkbox", { name: "eBay" }));
    await user.click(screen.getByRole("button", { name: "Publish Selected" }));
    await screen.findByText("This product changed after you opened it. Reload the latest version before saving again.");
  });
});

describe("PublishActions — post-publish canonical refresh", () => {
  it("after a successful (including partial-success) batch HTTP response, re-fetches the Product and calls onProductRefreshed with it", async () => {
    const user = userEvent.setup();
    vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch").mockResolvedValue({
      productId: "p1",
      results: [
        { channel: PublishChannel.NoctellaWeb, outcome: "succeeded", result: {} as any },
        { channel: PublishChannel.Ebay, outcome: "failed", error: { message: "boom" } },
      ],
    } as any);
    const refreshedProduct = product({ status: "published", updatedAt: "2026-03-01T00:00:00.000Z" });
    const getSpy = vi.spyOn(apiLib.api, "get").mockResolvedValue(refreshedProduct);
    const onProductRefreshed = vi.fn();
    render(<PublishActions productId="p1" isDirty={false} currentProductUpdatedAt="t" saveForPublish={alwaysOkSave()} onProductRefreshed={onProductRefreshed} />);
    await user.click(await screen.findByRole("checkbox", { name: "Noctella Web" }));
    await user.click(screen.getByRole("checkbox", { name: "eBay" }));
    await user.click(screen.getByRole("button", { name: "Publish Selected" }));
    await waitFor(() => expect(getSpy).toHaveBeenCalledWith("/api/products/p1"));
    await waitFor(() => expect(onProductRefreshed).toHaveBeenCalledWith(refreshedProduct));
  });

  it("does NOT re-fetch the Product when executePublishBatch itself throws (no successful HTTP response)", async () => {
    const user = userEvent.setup();
    vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch").mockRejectedValue(new ApiError("stale version", 409));
    const getSpy = vi.spyOn(apiLib.api, "get");
    render(<PublishActions productId="p1" isDirty={false} currentProductUpdatedAt="t" saveForPublish={alwaysOkSave()} onProductRefreshed={vi.fn()} />);
    await user.click(await screen.findByRole("checkbox", { name: "eBay" }));
    await user.click(screen.getByRole("button", { name: "Publish Selected" }));
    await screen.findByText("stale version");
    expect(getSpy).not.toHaveBeenCalledWith("/api/products/p1");
  });
});

describe("PublishActions — connection guidance", () => {
  it("shows a disconnected hint for eBay/Etsy when not connected, without exposing credentials", async () => {
    vi.spyOn(marketplacesLib.marketplaceApi, "listConnections").mockResolvedValue([]);
    render(<PublishActions productId="p1" isDirty={false} currentProductUpdatedAt="t" saveForPublish={alwaysOkSave()} onProductRefreshed={vi.fn()} />);
    expect(await screen.findAllByText("(disconnected)")).toHaveLength(2); // eBay and Etsy, never Noctella Web
  });

  it("Noctella Web is never shown as requiring a marketplace connection", async () => {
    vi.spyOn(marketplacesLib.marketplaceApi, "listConnections").mockResolvedValue([]);
    render(<PublishActions productId="p1" isDirty={false} currentProductUpdatedAt="t" saveForPublish={alwaysOkSave()} onProductRefreshed={vi.fn()} />);
    const webRow = (await screen.findByRole("checkbox", { name: "Noctella Web" })).closest("span");
    expect(webRow?.parentElement?.textContent).not.toContain("(disconnected)");
  });

  it("links to the existing Marketplaces management page rather than exposing connection management inline", async () => {
    render(<PublishActions productId="p1" isDirty={false} currentProductUpdatedAt="t" saveForPublish={alwaysOkSave()} onProductRefreshed={vi.fn()} />);
    const link = await screen.findByRole("link", { name: "Marketplaces" });
    expect(link).toHaveAttribute("href", "/marketplaces");
  });
});

describe("PublishActions — validation/preview guidance", () => {
  it("shows validation errors for a selected channel that is not ready to publish", async () => {
    const user = userEvent.setup();
    vi.spyOn(publishingLib.publishingApi, "getPreview").mockImplementation(async (_id, channel) =>
      (channel === PublishChannel.Ebay ? invalidPreview(channel) : validPreview(channel)) as any,
    );
    render(<PublishActions productId="p1" isDirty={false} currentProductUpdatedAt="t" saveForPublish={alwaysOkSave()} onProductRefreshed={vi.fn()} />);
    await user.click(await screen.findByRole("checkbox", { name: "eBay" }));
    expect(await screen.findByText("A valid positive EUR price is required before publishing")).toBeInTheDocument();
  });

  it("does not block Publish Selected merely because client-side preview shows an issue - the server remains authoritative", async () => {
    const user = userEvent.setup();
    vi.spyOn(publishingLib.publishingApi, "getPreview").mockImplementation(async (_id, channel) => invalidPreview(channel) as any);
    vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch").mockResolvedValue({ productId: "p1", results: [{ channel: PublishChannel.Ebay, outcome: "failed", error: { message: "validation" } }] } as any);
    vi.spyOn(apiLib.api, "get").mockResolvedValue(product());
    render(<PublishActions productId="p1" isDirty={false} currentProductUpdatedAt="t" saveForPublish={alwaysOkSave()} onProductRefreshed={vi.fn()} />);
    await user.click(await screen.findByRole("checkbox", { name: "eBay" }));
    expect(screen.getByRole("button", { name: "Publish Selected" })).toBeEnabled();
  });
});

/**
 * Sprint 147: onPublishComplete is PublishActions' navigation-completion signal - it never calls
 * useRouter itself (Option B: EditProductPage is the sole navigation owner; this component only
 * reports completion via the callback). Must fire once the resolved batch's post-publish refetch/
 * onProductRefreshed has already applied, regardless of per-channel outcome content, and must
 * never fire for a request-level rejection or a failed Save-before-Publish.
 */
describe("PublishActions — Sprint 147: onPublishComplete navigation signal", () => {
  it("fires after a resolved batch where the selected channel succeeded", async () => {
    const user = userEvent.setup();
    vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch").mockResolvedValue({
      productId: "p1",
      results: [{ channel: PublishChannel.NoctellaWeb, outcome: "succeeded", result: {} as any }],
    } as any);
    vi.spyOn(apiLib.api, "get").mockResolvedValue(product());
    const onPublishComplete = vi.fn();
    render(
      <PublishActions
        productId="p1"
        isDirty={false}
        currentProductUpdatedAt="t"
        saveForPublish={alwaysOkSave()}
        onProductRefreshed={vi.fn()}
        onPublishComplete={onPublishComplete}
      />,
    );
    await user.click(await screen.findByRole("checkbox", { name: "Noctella Web" }));
    await user.click(screen.getByRole("button", { name: "Publish Selected" }));
    await waitFor(() => expect(onPublishComplete).toHaveBeenCalledTimes(1));
  });

  it("fires after a resolved batch where an eBay-only selection succeeded", async () => {
    const user = userEvent.setup();
    vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch").mockResolvedValue({
      productId: "p1",
      results: [{ channel: PublishChannel.Ebay, outcome: "succeeded", result: {} as any }],
    } as any);
    vi.spyOn(apiLib.api, "get").mockResolvedValue(product());
    const onPublishComplete = vi.fn();
    render(
      <PublishActions productId="p1" isDirty={false} currentProductUpdatedAt="t" saveForPublish={alwaysOkSave()} onProductRefreshed={vi.fn()} onPublishComplete={onPublishComplete} />,
    );
    await user.click(await screen.findByRole("checkbox", { name: "eBay" }));
    await user.click(screen.getByRole("button", { name: "Publish Selected" }));
    await waitFor(() => expect(onPublishComplete).toHaveBeenCalledTimes(1));
  });

  it("fires after a resolved batch where an Etsy-only selection succeeded", async () => {
    const user = userEvent.setup();
    vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch").mockResolvedValue({
      productId: "p1",
      results: [{ channel: PublishChannel.Etsy, outcome: "succeeded", result: {} as any }],
    } as any);
    vi.spyOn(apiLib.api, "get").mockResolvedValue(product());
    const onPublishComplete = vi.fn();
    render(
      <PublishActions productId="p1" isDirty={false} currentProductUpdatedAt="t" saveForPublish={alwaysOkSave()} onProductRefreshed={vi.fn()} onPublishComplete={onPublishComplete} />,
    );
    await user.click(await screen.findByRole("checkbox", { name: "Etsy" }));
    await user.click(screen.getByRole("button", { name: "Publish Selected" }));
    await waitFor(() => expect(onPublishComplete).toHaveBeenCalledTimes(1));
  });

  it("fires even when the resolved batch contains only a normal 'failed' outcome", async () => {
    const user = userEvent.setup();
    vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch").mockResolvedValue({
      productId: "p1",
      results: [{ channel: PublishChannel.Ebay, outcome: "failed", error: { message: "Marketplace connection is not connected" } }],
    } as any);
    vi.spyOn(apiLib.api, "get").mockResolvedValue(product());
    const onPublishComplete = vi.fn();
    render(
      <PublishActions productId="p1" isDirty={false} currentProductUpdatedAt="t" saveForPublish={alwaysOkSave()} onProductRefreshed={vi.fn()} onPublishComplete={onPublishComplete} />,
    );
    await user.click(await screen.findByRole("checkbox", { name: "eBay" }));
    await user.click(screen.getByRole("button", { name: "Publish Selected" }));
    await waitFor(() => expect(onPublishComplete).toHaveBeenCalledTimes(1));
  });

  it("fires for a resolved partial-success batch", async () => {
    const user = userEvent.setup();
    vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch").mockResolvedValue({
      productId: "p1",
      results: [
        { channel: PublishChannel.NoctellaWeb, outcome: "succeeded", result: {} as any },
        { channel: PublishChannel.Ebay, outcome: "failed", error: { message: "boom" } },
      ],
    } as any);
    vi.spyOn(apiLib.api, "get").mockResolvedValue(product());
    const onPublishComplete = vi.fn();
    render(
      <PublishActions productId="p1" isDirty={false} currentProductUpdatedAt="t" saveForPublish={alwaysOkSave()} onProductRefreshed={vi.fn()} onPublishComplete={onPublishComplete} />,
    );
    await user.click(await screen.findByRole("checkbox", { name: "Noctella Web" }));
    await user.click(screen.getByRole("checkbox", { name: "eBay" }));
    await user.click(screen.getByRole("button", { name: "Publish Selected" }));
    await waitFor(() => expect(onPublishComplete).toHaveBeenCalledTimes(1));
  });

  it("fires for a resolved 'skipped' outcome", async () => {
    const user = userEvent.setup();
    vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch").mockResolvedValue({
      productId: "p1",
      results: [{ channel: PublishChannel.Ebay, outcome: "skipped", error: { message: "An active listing already exists for this product on this channel" } }],
    } as any);
    vi.spyOn(apiLib.api, "get").mockResolvedValue(product());
    const onPublishComplete = vi.fn();
    render(
      <PublishActions productId="p1" isDirty={false} currentProductUpdatedAt="t" saveForPublish={alwaysOkSave()} onProductRefreshed={vi.fn()} onPublishComplete={onPublishComplete} />,
    );
    await user.click(await screen.findByRole("checkbox", { name: "eBay" }));
    await user.click(screen.getByRole("button", { name: "Publish Selected" }));
    await waitFor(() => expect(onPublishComplete).toHaveBeenCalledTimes(1));
  });

  it("fires when ALL selected channels return normal failed results", async () => {
    const user = userEvent.setup();
    vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch").mockResolvedValue({
      productId: "p1",
      results: [
        { channel: PublishChannel.Ebay, outcome: "failed", error: { message: "not connected" } },
        { channel: PublishChannel.Etsy, outcome: "failed", error: { message: "not connected" } },
      ],
    } as any);
    vi.spyOn(apiLib.api, "get").mockResolvedValue(product());
    const onPublishComplete = vi.fn();
    render(
      <PublishActions productId="p1" isDirty={false} currentProductUpdatedAt="t" saveForPublish={alwaysOkSave()} onProductRefreshed={vi.fn()} onPublishComplete={onPublishComplete} />,
    );
    await user.click(await screen.findByRole("checkbox", { name: "eBay" }));
    await user.click(screen.getByRole("checkbox", { name: "Etsy" }));
    await user.click(screen.getByRole("button", { name: "Publish Selected" }));
    await waitFor(() => expect(onPublishComplete).toHaveBeenCalledTimes(1));
  });

  it("fires strictly AFTER the canonical Product refetch and onProductRefreshed have already been applied (explicit call-order proof)", async () => {
    const user = userEvent.setup();
    vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch").mockResolvedValue({
      productId: "p1",
      results: [{ channel: PublishChannel.Ebay, outcome: "succeeded", result: {} as any }],
    } as any);
    vi.spyOn(apiLib.api, "get").mockResolvedValue(product());
    const callOrder: string[] = [];
    const onProductRefreshed = vi.fn(() => callOrder.push("onProductRefreshed"));
    const onPublishComplete = vi.fn(() => callOrder.push("onPublishComplete"));
    render(
      <PublishActions productId="p1" isDirty={false} currentProductUpdatedAt="t" saveForPublish={alwaysOkSave()} onProductRefreshed={onProductRefreshed} onPublishComplete={onPublishComplete} />,
    );
    await user.click(await screen.findByRole("checkbox", { name: "eBay" }));
    await user.click(screen.getByRole("button", { name: "Publish Selected" }));
    await waitFor(() => expect(onPublishComplete).toHaveBeenCalled());
    expect(callOrder).toEqual(["onProductRefreshed", "onPublishComplete"]);
  });

  it("does NOT fire on a request-level rejection (e.g. PRODUCT_VERSION_CONFLICT) - the local error remains visible instead", async () => {
    const user = userEvent.setup();
    vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch").mockRejectedValue(
      new ApiError("This product changed after you opened it. Reload the latest version before saving again.", 409, undefined, "PRODUCT_VERSION_CONFLICT"),
    );
    const onPublishComplete = vi.fn();
    render(
      <PublishActions productId="p1" isDirty={false} currentProductUpdatedAt="t" saveForPublish={alwaysOkSave()} onProductRefreshed={vi.fn()} onPublishComplete={onPublishComplete} />,
    );
    await user.click(await screen.findByRole("checkbox", { name: "eBay" }));
    await user.click(screen.getByRole("button", { name: "Publish Selected" }));
    await screen.findByText("This product changed after you opened it. Reload the latest version before saving again.");
    expect(onPublishComplete).not.toHaveBeenCalled();
  });

  it("does NOT fire when Save-before-Publish fails - executePublishBatch remains blocked exactly as Sprint 146 requires", async () => {
    const user = userEvent.setup();
    const saveForPublish = vi.fn().mockResolvedValue({ ok: false });
    const executeBatchSpy = vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch");
    const onPublishComplete = vi.fn();
    render(
      <PublishActions productId="p1" isDirty={true} currentProductUpdatedAt="t" saveForPublish={saveForPublish} onProductRefreshed={vi.fn()} onPublishComplete={onPublishComplete} />,
    );
    await user.click(await screen.findByRole("checkbox", { name: "eBay" }));
    await user.click(screen.getByRole("button", { name: "Publish Selected" }));
    await waitFor(() => expect(saveForPublish).toHaveBeenCalled());
    expect(executeBatchSpy).not.toHaveBeenCalled();
    expect(onPublishComplete).not.toHaveBeenCalled();
  });

  it("onPublishComplete is optional - omitting it does not throw or block publication", async () => {
    const user = userEvent.setup();
    vi.spyOn(marketplacesLib.marketplaceApi, "executePublishBatch").mockResolvedValue({ productId: "p1", results: [] } as any);
    vi.spyOn(apiLib.api, "get").mockResolvedValue(product());
    render(<PublishActions productId="p1" isDirty={false} currentProductUpdatedAt="t" saveForPublish={alwaysOkSave()} onProductRefreshed={vi.fn()} />);
    await user.click(await screen.findByRole("checkbox", { name: "eBay" }));
    await user.click(screen.getByRole("button", { name: "Publish Selected" }));
    await waitFor(() => expect(marketplacesLib.marketplaceApi.executePublishBatch).toHaveBeenCalled());
  });
});
