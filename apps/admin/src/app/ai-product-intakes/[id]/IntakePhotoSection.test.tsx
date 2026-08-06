// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AiProductIntakeStatus } from "@noctella/shared";
import { ApiError } from "@/lib/api";
import * as aiProductIntakesLib from "@/lib/aiProductIntakes";
import { IntakePhotoSection } from "./IntakePhotoSection";

const photo = {
  id: "photo-1",
  intakeId: "intake-1",
  storageKey: "super-secret-storage-key.webp",
  originalFilename: "a.png",
  createdByAdminUserId: "admin-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

let createObjectURLSpy: ReturnType<typeof vi.fn>;
let revokeObjectURLSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  createObjectURLSpy = vi.fn(() => "blob:mock-url");
  revokeObjectURLSpy = vi.fn();
  vi.stubGlobal("URL", { ...URL, createObjectURL: createObjectURLSpy, revokeObjectURL: revokeObjectURLSpy });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("IntakePhotoSection (Sprint 97)", () => {
  it("renders a staged photo via an authenticated blob fetch and object URL", async () => {
    vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "fetchPhotoContent").mockResolvedValue(new Blob(["x"]));
    render(
      <IntakePhotoSection intakeId="intake-1" intakeStatus={AiProductIntakeStatus.Open} photos={[photo]} onPhotosChanged={vi.fn().mockResolvedValue([])} />,
    );
    await waitFor(() => expect(createObjectURLSpy).toHaveBeenCalled());
    const img = await screen.findByAltText("a.png");
    expect(img).toHaveAttribute("src", "blob:mock-url");
  });

  it("revokes object URLs when the photo list changes (unmount)", async () => {
    vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "fetchPhotoContent").mockResolvedValue(new Blob(["x"]));
    const { unmount } = render(
      <IntakePhotoSection intakeId="intake-1" intakeStatus={AiProductIntakeStatus.Open} photos={[photo]} onPhotosChanged={vi.fn().mockResolvedValue([])} />,
    );
    await waitFor(() => expect(createObjectURLSpy).toHaveBeenCalled());
    unmount();
    expect(revokeObjectURLSpy).toHaveBeenCalledWith("blob:mock-url");
  });

  it("never renders the raw storage key anywhere in the DOM", async () => {
    vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "fetchPhotoContent").mockResolvedValue(new Blob(["x"]));
    render(
      <IntakePhotoSection intakeId="intake-1" intakeStatus={AiProductIntakeStatus.Open} photos={[photo]} onPhotosChanged={vi.fn().mockResolvedValue([])} />,
    );
    await screen.findByAltText("a.png");
    expect(document.body.innerHTML).not.toContain("super-secret-storage-key");
  });

  it("shows the zero-photo state", () => {
    render(<IntakePhotoSection intakeId="intake-1" intakeStatus={AiProductIntakeStatus.Open} photos={[]} onPhotosChanged={vi.fn()} />);
    expect(screen.getByText("No staged photos yet.")).toBeInTheDocument();
  });

  it("allows upload while Open", () => {
    render(<IntakePhotoSection intakeId="intake-1" intakeStatus={AiProductIntakeStatus.Open} photos={[]} onPhotosChanged={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Upload photo" })).toBeInTheDocument();
  });

  it("hides upload while Cancelled and shows cancellation guidance", () => {
    render(<IntakePhotoSection intakeId="intake-1" intakeStatus={AiProductIntakeStatus.Cancelled} photos={[]} onPhotosChanged={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Upload photo" })).not.toBeInTheDocument();
    expect(screen.getByText(/Staged photos may still be removed/)).toBeInTheDocument();
  });

  it("allows delete while Open and while Cancelled, with an inline confirmation before the call", async () => {
    const user = userEvent.setup();
    vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "fetchPhotoContent").mockResolvedValue(new Blob(["x"]));
    const deleteSpy = vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "deletePhoto").mockResolvedValue(undefined);
    const onPhotosChanged = vi.fn().mockResolvedValue([]);
    render(<IntakePhotoSection intakeId="intake-1" intakeStatus={AiProductIntakeStatus.Cancelled} photos={[photo]} onPhotosChanged={onPhotosChanged} />);
    await screen.findByAltText("a.png");
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(deleteSpy).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm Delete" }));
    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith("intake-1", "photo-1"));
    expect(onPhotosChanged).toHaveBeenCalled();
  });

  it("does not offer delete once Applied", async () => {
    vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "fetchPhotoContent").mockResolvedValue(new Blob(["x"]));
    render(<IntakePhotoSection intakeId="intake-1" intakeStatus={AiProductIntakeStatus.Applied} photos={[photo]} onPhotosChanged={vi.fn()} />);
    await screen.findByAltText("a.png");
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  it("shows an inline error when the image blob fetch fails", async () => {
    vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "fetchPhotoContent").mockRejectedValue(new ApiError("Failed to load photo", 500));
    render(<IntakePhotoSection intakeId="intake-1" intakeStatus={AiProductIntakeStatus.Open} photos={[photo]} onPhotosChanged={vi.fn()} />);
    await screen.findByText("Failed to load photo");
  });
});
