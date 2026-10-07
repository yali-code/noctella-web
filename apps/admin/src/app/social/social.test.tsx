// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { SocialContent } from "@noctella/shared";
import { adminMenuItems } from "@/config/menu";
import { api } from "@/lib/api";
import { socialContentApi } from "@/lib/socialContent";
import SocialLayout from "./layout";
import SocialContentList from "./page";
import { ContentEditor } from "./ContentEditor";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
const product = { id: "p1", sku: "NOC-000008", title: "Collectible" };
const photo = { id: "photo1", productId: "p1", url: "/images/product-photos/photo.webp", thumbnailUrl: "/images/product-photos/photo-thumb.webp", altText: "Collectible photo", editorialAltText: null, processingStatus: "Ready" };
const record: SocialContent = { id: "content1", platform: "instagram", accountLabel: "vault", contentType: "post", status: "draft", caption: "A collectible", hashtags: null, concept: null, aiProvider: null, aiModel: null, aiPromptVersion: null, aiGeneratedAt: null, aiRequestId: null, aiSourceProductId: null, productId: "p1", product, media: [photo], missingMediaCount: 0, version: 1, createdAt: "2026-09-24T10:00:00Z", updatedAt: "2026-09-24T10:00:00Z" };
beforeEach(() => {
  push.mockReset();
  vi.spyOn(api, "get").mockImplementation(async (path) => (path.startsWith("/api/products?") ? { items: [product], total: 1 } : { ...product, photos: [photo] }) as any);
  vi.spyOn(socialContentApi, "get").mockResolvedValue(record);
  vi.spyOn(socialContentApi, "list").mockResolvedValue({ items: [], page: 1, hasMore: false });
  vi.spyOn(socialContentApi, "create").mockResolvedValue(record);
  vi.spyOn(socialContentApi, "edit").mockResolvedValue({ ...record, version: 2 });
  vi.spyOn(socialContentApi, "transition").mockImplementation(async (_id, status, version) => ({ ...record, status, version: version + 1 }));
  vi.spyOn(socialContentApi, "publishingChain").mockResolvedValue(emptyChain);
  vi.spyOn(socialContentApi, "publishingReadiness").mockResolvedValue(readyConfig);
  vi.spyOn(api, "post").mockRejectedValue(new Error("Unexpected direct API mutation"));
});
const emptyChain = { content: { id: "content1", status: "ready_for_review", version: 3 }, preparedImages: [], approvals: [] };
const readyConfig = { ready: true, mediaOriginAllowed: true, connection: "connected", missingConfiguration: [], checks: {} };
const prepared = { id: "prep1", sourcePhotoId: "photo1", recipeVersion: "instagram-v1", outputPath: "/images/product-photos/prep1.jpg" };
const approvalStep = { id: "approval1", preparedImageId: "prep1", contentVersion: 3, approvedAt: "2026-09-24T11:00:00Z", current: true,
  intent: null, schedule: null, execution: null, job: null, attempt: null };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Social Manager", () => {
  it("exposes Social Manager navigation and fixed Vault account", () => {
    expect(adminMenuItems).toContainEqual({ label: "Social Manager", href: "/social" });
    render(<SocialLayout><span>Content area</span></SocialLayout>);
    expect(screen.getByRole("navigation", { name: "Social Manager" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Media Pool" })).toHaveAttribute("href", "/social/media");
    expect(screen.getByRole("link", { name: "Create content" })).toHaveAttribute("href", "/social/new");
    expect(screen.getByText(/@noctella.vault/)).toBeInTheDocument();
  });
  it("shows the empty queue", async () => {
    render(<SocialContentList />);
    expect(await screen.findByText(/No social content yet/)).toBeInTheDocument();
  });
  it("renders content and requests status/type filters", async () => {
    vi.mocked(socialContentApi.list).mockResolvedValue({ items: [record], page: 1, hasMore: false });
    render(<SocialContentList />);
    expect(await screen.findByRole("link", { name: "View content" })).toHaveAttribute("href", "/social/content1");
    expect(screen.getByText(/NOC-000008/)).toBeInTheDocument();
    expect(screen.getByRole("img")).toHaveAttribute("alt", "Collectible photo");
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "approved" } });
    fireEvent.change(screen.getByLabelText("Content type"), { target: { value: "reel" } });
    await waitFor(() => expect(socialContentApi.list).toHaveBeenLastCalledWith("page=1&status=approved&contentType=reel"));
  });
  it("selects a canonical product/photo and creates a draft", async () => {
    render(<ContentEditor />);
    expect(screen.getByText(/@noctella.vault/)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /NOC-000008/ }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select photo photo1" }));
    expect(screen.getByRole("checkbox")).toBeChecked();
    fireEvent.change(screen.getByLabelText("Caption"), { target: { value: "New caption" } });
    fireEvent.change(screen.getByLabelText("Content type"), { target: { value: "story" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(socialContentApi.create).toHaveBeenCalledWith({ contentType: "story", caption: "New caption", productId: "p1", mediaIds: ["photo1"] }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/social/content1"));
    expect(socialContentApi.transition).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/account/i)).not.toBeInTheDocument();
  });
  it("keeps the photo label and count in sync when selecting and deselecting", async () => {
    render(<ContentEditor initialProductId="p1" />);
    const checkbox = await screen.findByRole("checkbox", { name: "Select photo photo1" });
    const card = checkbox.closest("label");
    expect(checkbox).not.toBeChecked();
    expect(card).toHaveTextContent(/^Select$/);
    expect(screen.getByText("0 photos selected (maximum 10).")).toBeInTheDocument();

    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    expect(card).toHaveTextContent(/^Selected$/);
    expect(screen.getByText("1 photos selected (maximum 10).")).toBeInTheDocument();

    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
    expect(card).toHaveTextContent(/^Select$/);
    expect(screen.getByText("0 photos selected (maximum 10).")).toBeInTheDocument();
  });
  it("edits a draft and submits the saved version explicitly", async () => {
    render(<ContentEditor id="content1" />);
    fireEvent.change(await screen.findByLabelText("Caption"), { target: { value: "Edited caption" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit for review" }));
    await waitFor(() => expect(socialContentApi.edit).toHaveBeenCalledWith("content1", expect.objectContaining({ caption: "Edited caption" }), 1));
    await waitFor(() => expect(socialContentApi.transition).toHaveBeenCalledWith("content1", "ready_for_review", 2));
    expect(await screen.findByRole("button", { name: "Prepare image" })).toBeInTheDocument();
    // Status-only approval is rejected by the API; approval is the explicit prepared-image step.
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });
  it.each([["Reject", "rejected"]] as const)("requires the explicit %s action", async (label, status) => {
    vi.mocked(socialContentApi.get).mockResolvedValue({ ...record, status: "ready_for_review", version: 3 });
    render(<ContentEditor id="content1" />);
    const action = await screen.findByRole("button", { name: label });
    expect(socialContentApi.transition).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Caption")).toBeDisabled();
    fireEvent.click(action);
    await waitFor(() => expect(socialContentApi.transition).toHaveBeenCalledWith("content1", status, 3));
    expect(socialContentApi.edit).not.toHaveBeenCalled();
  });
  it("returns rejected content to draft explicitly", async () => {
    vi.mocked(socialContentApi.get).mockResolvedValue({ ...record, status: "rejected" });
    render(<ContentEditor id="content1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Return to draft" }));
    expect(await screen.findByRole("button", { name: "Save draft" })).toBeInTheDocument();
    expect(socialContentApi.transition).toHaveBeenCalledWith("content1", "draft", 1);
  });
  it("shows approved content read-only without a publish action", async () => {
    vi.mocked(socialContentApi.get).mockResolvedValue({ ...record, status: "approved" });
    render(<ContentEditor id="content1" />);
    expect(await screen.findByText(/Approval does not publish/)).toBeInTheDocument();
    expect(screen.getByLabelText("Caption")).toBeDisabled();
    expect(screen.getByLabelText("Content type")).toBeDisabled();
    expect(screen.getByRole("img")).toHaveAttribute("alt", "Collectible photo");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(socialContentApi.transition).not.toHaveBeenCalled();
  });
  it("shows a safe save failure without submitting or navigating", async () => {
    vi.mocked(socialContentApi.edit).mockRejectedValue(new Error("private internals"));
    render(<ContentEditor id="content1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Submit for review" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Content could not be saved.");
    expect(screen.queryByText(/private internals/)).not.toBeInTheDocument();
    expect(socialContentApi.transition).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
});

describe("Scheduled publishing workflow", () => {
  const noPublishNow = () => {
    expect(screen.queryByRole("button", { name: /publish now/i })).not.toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  };
  it("prepares an image and approves it as separate explicit actions", async () => {
    vi.mocked(socialContentApi.get).mockResolvedValue({ ...record, status: "ready_for_review", version: 3 });
    const prepareImage = vi.spyOn(socialContentApi, "prepareImage").mockResolvedValue(prepared);
    const approve = vi.spyOn(socialContentApi, "approve").mockResolvedValue({ id: "approval1" });
    render(<ContentEditor id="content1" />);
    expect(await screen.findByText("Prepare an image before approval.")).toBeInTheDocument();
    vi.mocked(socialContentApi.publishingChain).mockResolvedValue({ ...emptyChain, preparedImages: [prepared] });
    fireEvent.click(screen.getByRole("button", { name: "Prepare image" }));
    await waitFor(() => expect(prepareImage).toHaveBeenCalledWith("content1", "photo1"));
    expect(approve).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Approve with prepared image" }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith("content1", "prep1", 3));
    expect(socialContentApi.transition).not.toHaveBeenCalled();
    noPublishNow();
  });
  it("records intent and schedule only through their own explicit steps", async () => {
    vi.mocked(socialContentApi.get).mockResolvedValue({ ...record, status: "approved", version: 4 });
    vi.mocked(socialContentApi.publishingChain).mockResolvedValue({ ...emptyChain, preparedImages: [prepared], approvals: [approvalStep] });
    const createIntent = vi.spyOn(socialContentApi, "createPublishIntent").mockResolvedValue({ id: "intent1" });
    const schedule = vi.spyOn(socialContentApi, "schedulePublication").mockResolvedValue({ id: "schedule1" });
    render(<ContentEditor id="content1" />);
    expect(await screen.findByRole("button", { name: "Create publish intent" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Schedule publication" })).not.toBeInTheDocument();
    vi.mocked(socialContentApi.publishingChain).mockResolvedValue({ ...emptyChain, approvals: [{ ...approvalStep, intent: { id: "intent1", createdAt: "2026-09-24T11:05:00Z" } }] });
    fireEvent.click(screen.getByRole("button", { name: "Create publish intent" }));
    await waitFor(() => expect(createIntent).toHaveBeenCalledWith("approval1"));
    expect(schedule).not.toHaveBeenCalled();
    fireEvent.change(await screen.findByLabelText("Publication time"), { target: { value: "2030-01-02T10:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule publication" }));
    await waitFor(() => expect(schedule).toHaveBeenCalledWith("intent1", new Date("2030-01-02T10:30").toISOString()));
    noPublishNow();
  });
  it.each(["reconciliation_required", "publishing"])("shows %s as manual investigation with no action at all", async (status) => {
    vi.mocked(socialContentApi.get).mockResolvedValue({ ...record, status: "approved", version: 4 });
    vi.mocked(socialContentApi.publishingChain).mockResolvedValue({ ...emptyChain, approvals: [{ ...approvalStep,
      intent: { id: "intent1", createdAt: "2026-09-24T11:05:00Z" }, schedule: { id: "schedule1", requestedPublicationAt: "2030-01-02T10:30:00Z", createdAt: "2026-09-24T11:06:00Z" },
      execution: { id: "execution1", createdAt: "2030-01-02T11:00:00Z" },
      job: { id: "job1", status: "failed", attemptCount: 1, maxAttempts: 5, lastError: "Conflict: Social schedule publishing failed", runAfter: "2030-01-02T11:00:00Z", completedAt: null, updatedAt: "2030-01-02T11:00:00Z" },
      attempt: { id: "igp_1", origin: "scheduled", status, providerEntryState: "claimed", hasContainer: true, lastError: "provider", publishedAt: null, updatedAt: "2030-01-02T11:00:00Z", requiresManualReconciliation: true } }] });
    render(<ContentEditor id="content1" />);
    expect(await screen.findByText(/Requires manual investigation/)).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    noPublishNow();
  });
  it("shows missing configuration by name and never verifies the connection passively", async () => {
    vi.mocked(socialContentApi.get).mockResolvedValue({ ...record, status: "approved", version: 4 });
    vi.mocked(socialContentApi.publishingReadiness).mockResolvedValue({ ...readyConfig, ready: false, connection: "missing", missingConfiguration: ["INSTAGRAM_API_VERSION"] });
    render(<ContentEditor id="content1" />);
    expect(await screen.findByText(/Missing or invalid configuration: INSTAGRAM_API_VERSION/)).toBeInTheDocument();
    expect(screen.getByText(/Not ready/)).toBeInTheDocument();
    expect(screen.getByText("Instagram connection: missing")).toBeInTheDocument();
    noPublishNow();
  });
  it("tolerates readiness being unavailable for the role", async () => {
    vi.mocked(socialContentApi.get).mockResolvedValue({ ...record, status: "approved", version: 4 });
    vi.mocked(socialContentApi.publishingReadiness).mockRejectedValue(new Error("forbidden"));
    render(<ContentEditor id="content1" />);
    expect(await screen.findByText(/not available for your role/)).toBeInTheDocument();
  });
});
