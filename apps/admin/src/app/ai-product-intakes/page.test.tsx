// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AiProductIntakeStatus } from "@noctella/shared";
import { ApiError } from "@/lib/api";
import * as aiProductIntakesLib from "@/lib/aiProductIntakes";
import AiProductIntakesPage from "./page";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

afterEach(() => {
  vi.restoreAllMocks();
  push.mockClear();
});

function intake(overrides: Record<string, unknown> = {}) {
  return {
    id: "intake-1",
    status: AiProductIntakeStatus.Open,
    createdByAdminUserId: "admin-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("AiProductIntakesPage (Sprint 97)", () => {
  it("loads and renders the list", async () => {
    vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "list").mockResolvedValue({ items: [intake()], total: 1, page: 1, pageSize: 20 });
    render(<AiProductIntakesPage />);
    await screen.findByText(AiProductIntakeStatus.Open);
  });

  it("shows the empty state when there are no intakes", async () => {
    vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "list").mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    render(<AiProductIntakesPage />);
    await screen.findByText("No AI product intakes found.");
  });

  it("shows an error state on load failure", async () => {
    vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "list").mockRejectedValue(new ApiError("network down", 500));
    render(<AiProductIntakesPage />);
    await screen.findByText("network down");
  });

  it("re-lists with the selected status filter", async () => {
    const user = userEvent.setup();
    const listSpy = vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "list").mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    render(<AiProductIntakesPage />);
    await waitFor(() => expect(listSpy).toHaveBeenCalledWith({ page: 1, pageSize: 20, status: undefined }));
    await user.selectOptions(screen.getByRole("combobox"), AiProductIntakeStatus.Cancelled);
    await waitFor(() => expect(listSpy).toHaveBeenLastCalledWith({ page: 1, pageSize: 20, status: AiProductIntakeStatus.Cancelled }));
  });

  it("paginates using page controls", async () => {
    const user = userEvent.setup();
    const listSpy = vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "list").mockResolvedValue({ items: [intake()], total: 40, page: 1, pageSize: 20 });
    render(<AiProductIntakesPage />);
    await screen.findByText(AiProductIntakeStatus.Open);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(listSpy).toHaveBeenLastCalledWith({ page: 2, pageSize: 20, status: undefined }));
  });

  it("creates an intake and navigates to its detail page", async () => {
    const user = userEvent.setup();
    vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "list").mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "create").mockResolvedValue(intake({ id: "new-intake" }));
    render(<AiProductIntakesPage />);
    await screen.findByText("No AI product intakes found.");
    await user.click(screen.getByRole("button", { name: "New Intake" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/ai-product-intakes/new-intake"));
  });
});
