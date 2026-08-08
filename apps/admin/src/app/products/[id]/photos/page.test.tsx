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
