// @vitest-environment jsdom
// Sprint 112: multi-select photo upload usability. The backend remains single-photo-per-request
// (POST /api/products/:id/photos, multer.single("photo")) - these tests prove the page uploads
// every selected file sequentially against the existing productPhotoApi.upload(...) function, one
// awaited call per file, never in parallel, so the backend's own sortOrder/primary-photo semantics
// (computed per request) remain authoritative and follow selection order.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as apiLib from "@/lib/api";
import * as productPhotosLib from "@/lib/productPhotos";
import ProductPhotosPage from "./page";

afterEach(() => vi.restoreAllMocks());

function baseProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    sku: "SKU-1",
    title: "Original Title",
    slug: "original-title",
    type: "unique",
    status: "draft",
    priceEur: 100,
    stockQuantity: 1,
    images: [],
    photos: [],
    marketplaceReadiness: {
      ebay: { ready: false, missingFields: [] },
      etsy: { ready: false, missingFields: [] },
      woocommerce: { ready: false, missingFields: [] },
    },
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as any;
}

function file(name: string): File {
  return new File(["content"], name, { type: "image/jpeg" });
}

function photo(id: string, filename: string, isPrimary = false, altText: string | null = null) {
  return { id, productId: "p1", filename, isPrimary, altText, sortOrder: isPrimary ? 0 : 1, width: 100, height: 100, mimeType: "image/webp", sizeBytes: 10, processingStatus: "Ready", url: `/images/${filename}`, thumbnailUrl: `/images/${filename}` } as any;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("ProductPhotosPage — Sprint 112 multi-select upload", () => {
  it("the file input supports multiple selection", async () => {
    vi.spyOn(apiLib.api, "get").mockResolvedValue(baseProduct());
    render(<ProductPhotosPage params={{ id: "p1" }} />);
    await screen.findByText("Manage Photos — Original Title");
    const fileInput = document.querySelector("input[type=file]");
    expect(fileInput).toHaveAttribute("multiple");
  });

  it("selecting multiple files uploads one call per file, in selection order, sequentially (not in parallel)", async () => {
    const user = userEvent.setup();
    vi.spyOn(apiLib.api, "get").mockResolvedValue(baseProduct());

    // Sprint 112: a controllable, manually-resolved promise per call proves request N+1 does not
    // start before request N settles - a plain mockResolvedValue would not distinguish sequential
    // from parallel execution.
    const resolvers: Array<() => void> = [];
    const calls: string[] = [];
    const uploadSpy = vi.spyOn(productPhotosLib.productPhotoApi, "upload").mockImplementation((_id, uploaded) => {
      calls.push(uploaded.name);
      return new Promise((resolve) => {
        resolvers.push(() => resolve({} as any));
      });
    });

    render(<ProductPhotosPage params={{ id: "p1" }} />);
    await screen.findByText("Manage Photos — Original Title");
    const fileInput = document.querySelector("input[type=file]") as HTMLInputElement;
    await user.upload(fileInput, [file("a.jpg"), file("b.jpg"), file("c.jpg")]);
    await user.click(screen.getByRole("button", { name: /Upload 3 photos/ }));

    await waitFor(() => expect(uploadSpy).toHaveBeenCalledTimes(1));
    expect(calls).toEqual(["a.jpg"]); // only the first request has been issued so far

    resolvers[0]!();
    await waitFor(() => expect(uploadSpy).toHaveBeenCalledTimes(2));
    expect(calls).toEqual(["a.jpg", "b.jpg"]);

    resolvers[1]!();
    await waitFor(() => expect(uploadSpy).toHaveBeenCalledTimes(3));
    expect(calls).toEqual(["a.jpg", "b.jpg", "c.jpg"]);

    resolvers[2]!();
    await waitFor(() => expect(screen.getByText(/Uploaded 3 photo/)).toBeInTheDocument());
  });

  it("single-file selection still works", async () => {
    const user = userEvent.setup();
    vi.spyOn(apiLib.api, "get").mockResolvedValue(baseProduct());
    const uploadSpy = vi.spyOn(productPhotosLib.productPhotoApi, "upload").mockResolvedValue({} as any);

    render(<ProductPhotosPage params={{ id: "p1" }} />);
    await screen.findByText("Manage Photos — Original Title");
    const fileInput = document.querySelector("input[type=file]") as HTMLInputElement;
    await user.upload(fileInput, file("solo.jpg"));
    await user.click(screen.getByRole("button", { name: "Upload photo" }));

    await waitFor(() => expect(uploadSpy).toHaveBeenCalledTimes(1));
    expect(uploadSpy).toHaveBeenCalledWith("p1", expect.objectContaining({ name: "solo.jpg" }), "");
  });

  it("a failure in the middle of the batch does not prevent the later file from being attempted, and reports the failure", async () => {
    const user = userEvent.setup();
    vi.spyOn(apiLib.api, "get").mockResolvedValue(baseProduct());
    const uploadSpy = vi
      .spyOn(productPhotosLib.productPhotoApi, "upload")
      .mockResolvedValueOnce({} as any)
      .mockRejectedValueOnce(new Error("upload failed"))
      .mockResolvedValueOnce({} as any);

    render(<ProductPhotosPage params={{ id: "p1" }} />);
    await screen.findByText("Manage Photos — Original Title");
    const fileInput = document.querySelector("input[type=file]") as HTMLInputElement;
    await user.upload(fileInput, [file("a.jpg"), file("bad.jpg"), file("c.jpg")]);
    await user.click(screen.getByRole("button", { name: /Upload 3 photos/ }));

    await waitFor(() => expect(uploadSpy).toHaveBeenCalledTimes(3));
    expect(uploadSpy).toHaveBeenNthCalledWith(3, "p1", expect.objectContaining({ name: "c.jpg" }), "");
    await screen.findByText(/Uploaded 2 of 3 photo.*Failed: bad\.jpg/);
  });

  it("does not resend already-completed files after the batch finishes and the input resets", async () => {
    const user = userEvent.setup();
    vi.spyOn(apiLib.api, "get").mockResolvedValue(baseProduct());
    const uploadSpy = vi.spyOn(productPhotosLib.productPhotoApi, "upload").mockResolvedValue({} as any);

    render(<ProductPhotosPage params={{ id: "p1" }} />);
    await screen.findByText("Manage Photos — Original Title");
    const fileInput = document.querySelector("input[type=file]") as HTMLInputElement;
    await user.upload(fileInput, [file("a.jpg"), file("b.jpg")]);
    await user.click(screen.getByRole("button", { name: /Upload 2 photos/ }));
    await waitFor(() => expect(uploadSpy).toHaveBeenCalledTimes(2));

    // the submit button is disabled with nothing selected once the batch completes and the
    // selection resets - a second click cannot resend the same files.
    await waitFor(() => expect(screen.getByRole("button", { name: "Upload photo" })).toBeDisabled());
    expect(uploadSpy).toHaveBeenCalledTimes(2);
  });
});

describe("ProductPhotosPage — Roadmap B operation ownership", () => {
  it("saves alt text and preserves another dirty draft across reload", async () => {
    const user = userEvent.setup();
    const photos = [photo("a", "a.webp", true, "A"), photo("b", "b.webp", false, "B")];
    vi.spyOn(apiLib.api, "get").mockResolvedValue(baseProduct({ photos }));
    const save = vi.spyOn(productPhotosLib.productPhotoApi, "updateAltText").mockResolvedValue({} as any);
    render(<ProductPhotosPage params={{ id: "p1" }} />);
    const a = await screen.findByLabelText("Alt text for a.webp");
    const b = screen.getByLabelText("Alt text for b.webp");
    await user.clear(a); await user.type(a, "New A");
    await user.clear(b); await user.type(b, "Unsaved B");
    await user.click(screen.getAllByRole("button", { name: "Save alt text" })[0]!);
    await screen.findByText("Successfully completed: save alt text.");
    expect(save).toHaveBeenCalledWith("p1", "a", "New A");
    expect(screen.getByLabelText("Alt text for b.webp")).toHaveValue("Unsaved B");
  });

  it("reports alt-save failure as an accessible alert", async () => {
    const user = userEvent.setup();
    vi.spyOn(apiLib.api, "get").mockResolvedValue(baseProduct({ photos: [photo("a", "a.webp", true, "A")] }));
    vi.spyOn(productPhotosLib.productPhotoApi, "updateAltText").mockRejectedValue(new Error("save rejected"));
    render(<ProductPhotosPage params={{ id: "p1" }} />);
    const input = await screen.findByLabelText("Alt text for a.webp");
    await user.clear(input); await user.type(input, "Changed");
    await user.click(screen.getByRole("button", { name: "Save alt text" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to save alt text: save rejected");
  });

  it("honors delete cancellation and confirmation", async () => {
    const user = userEvent.setup();
    vi.spyOn(apiLib.api, "get").mockResolvedValue(baseProduct({ photos: [photo("a", "a.webp", true)] }));
    const remove = vi.spyOn(productPhotosLib.productPhotoApi, "delete").mockResolvedValue({} as any);
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<ProductPhotosPage params={{ id: "p1" }} />);
    await screen.findByText("Manage Photos — Original Title");
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(remove).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("p1", "a"));
    expect(confirm).toHaveBeenCalledWith("Delete a.webp? This cannot be undone.");
  });

  it("reports delete failure and releases the operation lock", async () => {
    const user = userEvent.setup();
    vi.spyOn(apiLib.api, "get").mockResolvedValue(baseProduct({ photos: [photo("a", "a.webp", true)] }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.spyOn(productPhotosLib.productPhotoApi, "delete").mockRejectedValue(new Error("delete rejected"));
    render(<ProductPhotosPage params={{ id: "p1" }} />);
    await screen.findByText("Manage Photos — Original Title");
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to delete photo: delete rejected");
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
  });

  it("locks photo mutations throughout upload and exposes lifecycle status", async () => {
    const user = userEvent.setup();
    vi.spyOn(apiLib.api, "get").mockResolvedValue(baseProduct({ photos: [photo("a", "a.webp", true), photo("b", "b.webp")] }));
    const pending = deferred<any>();
    vi.spyOn(productPhotosLib.productPhotoApi, "upload").mockReturnValue(pending.promise);
    const primary = vi.spyOn(productPhotosLib.productPhotoApi, "setPrimary").mockResolvedValue({} as any);
    render(<ProductPhotosPage params={{ id: "p1" }} />);
    await screen.findByText("Manage Photos — Original Title");
    await user.upload(document.querySelector("input[type=file]") as HTMLInputElement, file("new.jpg"));
    await user.click(screen.getByRole("button", { name: "Upload photo" }));
    expect(await screen.findByText("new.jpg: uploading")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Set primary" })[1]).toBeDisabled();
    await user.click(screen.getAllByRole("button", { name: "Set primary" })[1]!);
    expect(primary).not.toHaveBeenCalled();
    pending.resolve({});
    await screen.findByText("new.jpg: completed");
  });

  it("blocks upload during a photo mutation", async () => {
    const user = userEvent.setup();
    vi.spyOn(apiLib.api, "get").mockResolvedValue(baseProduct({ photos: [photo("a", "a.webp", true), photo("b", "b.webp")] }));
    const pending = deferred<any>();
    vi.spyOn(productPhotosLib.productPhotoApi, "setPrimary").mockReturnValue(pending.promise);
    render(<ProductPhotosPage params={{ id: "p1" }} />);
    await screen.findByText("Manage Photos — Original Title");
    await user.upload(document.querySelector("input[type=file]") as HTMLInputElement, file("new.jpg"));
    await user.click(screen.getAllByRole("button", { name: "Set primary" })[1]!);
    expect(screen.getByRole("button", { name: "Upload photo" })).toBeDisabled();
    pending.resolve({});
    await screen.findByText("Successfully completed: set primary photo.");
  });

  it("enforces primary and reorder boundaries", async () => {
    vi.spyOn(apiLib.api, "get").mockResolvedValue(baseProduct({ photos: [photo("a", "a.webp", true), photo("b", "b.webp")] }));
    render(<ProductPhotosPage params={{ id: "p1" }} />);
    await screen.findByText("Manage Photos — Original Title");
    expect(screen.getByLabelText("Move a.webp earlier")).toBeDisabled();
    expect(screen.getByLabelText("Move b.webp later")).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Set primary" })[0]).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Set primary" })[1]).toBeEnabled();
  });
});
