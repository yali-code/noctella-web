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
const photo = { id: "photo1", productId: "p1", url: "/images/product-photos/photo.webp", thumbnailUrl: "/images/product-photos/photo-thumb.webp", altText: "Collectible photo", processingStatus: "Ready" };
const record: SocialContent = { id: "content1", platform: "instagram", accountLabel: "vault", contentType: "post", status: "draft", caption: "A collectible", productId: "p1", product, media: [photo], missingMediaCount: 0, version: 1, createdAt: "2026-09-24T10:00:00Z", updatedAt: "2026-09-24T10:00:00Z" };
beforeEach(() => {
  push.mockReset();
  vi.spyOn(api, "get").mockImplementation(async (path) => (path.startsWith("/api/products?") ? { items: [product], total: 1 } : { ...product, photos: [photo] }) as any);
  vi.spyOn(socialContentApi, "get").mockResolvedValue(record);
  vi.spyOn(socialContentApi, "list").mockResolvedValue({ items: [], page: 1, hasMore: false });
  vi.spyOn(socialContentApi, "create").mockResolvedValue(record);
  vi.spyOn(socialContentApi, "edit").mockResolvedValue({ ...record, version: 2 });
  vi.spyOn(socialContentApi, "transition").mockImplementation(async (_id, status, version) => ({ ...record, status, version: version + 1 }));
});
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
  it("edits a draft and submits the saved version explicitly", async () => {
    render(<ContentEditor id="content1" />);
    fireEvent.change(await screen.findByLabelText("Caption"), { target: { value: "Edited caption" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit for review" }));
    await waitFor(() => expect(socialContentApi.edit).toHaveBeenCalledWith("content1", expect.objectContaining({ caption: "Edited caption" }), 1));
    await waitFor(() => expect(socialContentApi.transition).toHaveBeenCalledWith("content1", "ready_for_review", 2));
    expect(await screen.findByRole("button", { name: "Approve" })).toBeInTheDocument();
  });
  it.each([["Approve", "approved"], ["Reject", "rejected"]] as const)("requires the explicit %s action", async (label, status) => {
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
