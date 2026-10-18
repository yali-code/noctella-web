// @vitest-environment jsdom
// Sprint 112: multi-select photo upload usability. The backend remains single-photo-per-request
// (POST /api/products/:id/photos, multer.single("photo")) - these tests prove the page uploads
// every selected file sequentially against the existing productPhotoApi.upload(...) function, one
// awaited call per file, never in parallel, so the backend's own sortOrder/primary-photo semantics
// (computed per request) remain authoritative and follow selection order.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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

describe("ProductPhotosPage — Etsy media preview integration", () => {
  const preview = () => screen.getByRole("region", { name: "Etsy Media Preview" });

  it("uses only canonical photos, performs one product read and no writes on mount", async () => {
    const get = vi.spyOn(apiLib.api, "get").mockResolvedValue(baseProduct({ photos: [photo("a", "a.webp", true, "Canonical")], images: [{ url: "/legacy.webp", isPrimary: true }] }));
    const post = vi.spyOn(apiLib.api, "post");
    const put = vi.spyOn(apiLib.api, "put");
    const remove = vi.spyOn(apiLib.api, "delete");
    render(<ProductPhotosPage params={{ id: "p1" }} />);
    await screen.findByText("Etsy rank 1 — Primary image");
    expect(within(preview()).getByRole("img", { name: "Canonical" })).toBeInTheDocument();
    expect(preview().innerHTML).not.toContain("legacy.webp");
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/api/products/p1");
    expect(post).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  });

  it("shows an accessible initial read failure rather than endless loading", async () => {
    vi.spyOn(apiLib.api, "get").mockRejectedValue(new Error("fetch failed"));
    render(<ProductPhotosPage params={{ id: "p1" }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading Etsy media preview");
    expect(await screen.findByRole("alert")).toHaveTextContent("preview unavailable");
    expect(screen.queryByText(/Eligible for media preview/)).not.toBeInTheDocument();
  });

  it("refreshes the preview from the authoritative read after primary selection", async () => {
    const user = userEvent.setup();
    const before = [photo("a", "a.webp", true, "A"), photo("b", "b.webp", false, "B")];
    const after = [photo("a", "a.webp", false, "A"), photo("b", "b.webp", true, "B")];
    vi.spyOn(apiLib.api, "get").mockResolvedValueOnce(baseProduct({ photos: before })).mockResolvedValueOnce(baseProduct({ photos: after }));
    const primary = vi.spyOn(productPhotosLib.productPhotoApi, "setPrimary").mockResolvedValue([]);
    render(<ProductPhotosPage params={{ id: "p1" }} />);
    await screen.findByText("Etsy rank 1 — Primary image");
    await user.click(screen.getAllByRole("button", { name: "Set primary" })[1]!);
    await screen.findByText("Successfully completed: set primary photo.");
    expect(primary).toHaveBeenCalledWith("p1", "b");
    const first = within(screen.getByRole("list", { name: "Etsy candidate images" })).getAllByRole("listitem")[0]!;
    expect(within(first).getByRole("img")).toHaveAttribute("alt", "B");
    expect(before[0].isPrimary).toBe(true);
  });

  it("keeps alt drafts out of the preview until the existing save and canonical reload complete", async () => {
    const user = userEvent.setup();
    vi.spyOn(apiLib.api, "get").mockResolvedValueOnce(baseProduct({ photos: [photo("a", "a.webp", true, "Original alt")] }))
      .mockResolvedValueOnce(baseProduct({ photos: [photo("a", "a.webp", true, "Saved alt")] }));
    const save = vi.spyOn(productPhotosLib.productPhotoApi, "updateAltText").mockResolvedValue({} as any);
    render(<ProductPhotosPage params={{ id: "p1" }} />);
    const input = await screen.findByLabelText("Alt text for a.webp");
    await user.clear(input); await user.type(input, "Saved alt");
    expect(within(preview()).getByRole("img")).toHaveAttribute("alt", "Original alt");
    await user.click(screen.getByRole("button", { name: "Save alt text" }));
    await screen.findByText("Successfully completed: save alt text.");
    expect(within(preview()).getByRole("img")).toHaveAttribute("alt", "Saved alt");
    expect(save).toHaveBeenCalledWith("p1", "a", "Saved alt");
  });

  it("retains the last read after a failed operation, then reflects a manual reload without retrying the write", async () => {
    const user = userEvent.setup();
    const get = vi.spyOn(apiLib.api, "get").mockResolvedValueOnce(baseProduct({ photos: [photo("a", "a.webp", true, "Old")] }))
      .mockResolvedValueOnce(baseProduct({ photos: [photo("a", "a.webp", true, "Fresh")] }));
    const save = vi.spyOn(productPhotosLib.productPhotoApi, "updateAltText").mockRejectedValue(new Error("save rejected"));
    render(<ProductPhotosPage params={{ id: "p1" }} />);
    const input = await screen.findByLabelText("Alt text for a.webp");
    await user.clear(input); await user.type(input, "Draft");
    await user.click(screen.getByRole("button", { name: "Save alt text" }));
    await screen.findByRole("alert");
    expect(within(preview()).getByRole("img")).toHaveAttribute("alt", "Old");
    expect(get).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Reload product photos" }));
    await waitFor(() => expect(within(preview()).getByRole("img")).toHaveAttribute("alt", "Fresh"));
    expect(save).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue("Draft");
  });

  it("hides stale eligibility while reloading and after a failed reload", async () => {
    const user = userEvent.setup();
    const pending = deferred<any>();
    vi.spyOn(apiLib.api, "get").mockResolvedValueOnce(baseProduct({ photos: [photo("a", "a.webp", true, "A")] })).mockReturnValueOnce(pending.promise);
    render(<ProductPhotosPage params={{ id: "p1" }} />);
    await screen.findByText("Etsy rank 1 — Primary image");
    await user.click(screen.getByRole("button", { name: "Reload product photos" }));
    expect(within(preview()).getByRole("status")).toHaveTextContent("Loading");
    expect(within(preview()).queryByRole("img")).not.toBeInTheDocument();
    pending.reject(new Error("read failed"));
    expect(await within(preview()).findByRole("alert")).toHaveTextContent("preview unavailable");
    expect(within(preview()).queryByText(/Eligible for media preview/)).not.toBeInTheDocument();
  });

  it("uses the existing failed-upload reload to refresh the preview without creating a photo", async () => {
    const user = userEvent.setup();
    vi.spyOn(apiLib.api, "get").mockResolvedValueOnce(baseProduct()).mockResolvedValueOnce(baseProduct({ photos: [photo("a", "a.webp", true, "Reloaded")] }));
    const upload = vi.spyOn(productPhotosLib.productPhotoApi, "upload").mockRejectedValue(new Error("upload rejected"));
    render(<ProductPhotosPage params={{ id: "p1" }} />);
    await screen.findByText("No canonical photos yet.");
    await user.upload(document.querySelector("input[type=file]") as HTMLInputElement, file("bad.jpg"));
    await user.click(screen.getByRole("button", { name: "Upload photo" }));
    await screen.findByText("Etsy rank 1 — Primary image");
    expect(within(preview()).getByRole("img")).toHaveAttribute("alt", "Reloaded");
    expect(upload).toHaveBeenCalledTimes(1);
  });
});
