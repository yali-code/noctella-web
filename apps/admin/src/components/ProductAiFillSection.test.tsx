// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { ProductAiFillSection } from "./ProductAiFillSection";

afterEach(() => vi.restoreAllMocks());

describe("ProductAiFillSection", () => {
  it("is blocked while the form has unsaved changes", () => {
    render(<ProductAiFillSection productId="p1" dirty onFilled={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Fill all fields with AI" })).toBeDisabled();
  });

  it("makes one request and hands the product back", async () => {
    const product = { id: "p1" } as any;
    const post = vi.spyOn(api, "post").mockResolvedValue(product);
    const onFilled = vi.fn();
    render(<ProductAiFillSection productId="p1" dirty={false} onFilled={onFilled} />);
    fireEvent.click(screen.getByRole("button", { name: "Fill all fields with AI" }));
    await waitFor(() => expect(onFilled).toHaveBeenCalledWith(product));
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/api/products/p1/ai-fill", { replaceExisting: false });
  });
});
