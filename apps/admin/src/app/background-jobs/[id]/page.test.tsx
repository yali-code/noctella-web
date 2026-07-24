// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as bridge from "@/lib/stockSyncJobs";
import BackgroundJobDetail from "./page";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

afterEach(() => vi.restoreAllMocks());

const baseJob = (overrides: any = {}) => ({ id: "job-1", type: "stock_sync_listing", status: "failed", attemptCount: 1, maxAttempts: 5, runAfter: "now", payloadSnapshot: "{}", ...overrides });

describe("Background job detail page (Sprint 63B)", () => {
  it("renders real job data", async () => {
    vi.spyOn(bridge, "getBackgroundJob").mockResolvedValue(baseJob());
    render(await BackgroundJobDetail({ params: { id: "job-1" } }));
    expect(screen.getByText("Background job job-1")).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
  });

  it("renders a graceful error state instead of throwing", async () => {
    vi.spyOn(bridge, "getBackgroundJob").mockRejectedValue(new Error("Background job not found"));
    render(await BackgroundJobDetail({ params: { id: "missing" } }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Background job not found");
  });

  it("shows Retry only when canRetryJob is true", async () => {
    vi.spyOn(bridge, "getBackgroundJob").mockResolvedValue(baseJob({ status: "failed" }));
    render(await BackgroundJobDetail({ params: { id: "job-1" } }));
    expect(screen.getByText("Retry")).toBeInTheDocument();
    expect(screen.queryByText("Cancel")).not.toBeInTheDocument();
  });

  it("shows Cancel only when canCancelJob is true", async () => {
    vi.spyOn(bridge, "getBackgroundJob").mockResolvedValue(baseJob({ status: "processing" }));
    render(await BackgroundJobDetail({ params: { id: "job-1" } }));
    expect(screen.getByText("Cancel")).toBeInTheDocument();
    expect(screen.queryByText("Retry")).not.toBeInTheDocument();
  });

  it("requires explicit confirmation before cancelling, then reloads authoritative data", async () => {
    const user = userEvent.setup();
    vi.spyOn(bridge, "getBackgroundJob").mockResolvedValue(baseJob({ status: "processing" }));
    const cancelSpy = vi.spyOn(bridge, "cancelBackgroundJob").mockResolvedValue({} as any);
    render(await BackgroundJobDetail({ params: { id: "job-1" } }));
    await user.click(screen.getByText("Cancel"));
    expect(cancelSpy).not.toHaveBeenCalled();
    await user.click(screen.getByText("Confirm Cancel"));
    await waitFor(() => expect(cancelSpy).toHaveBeenCalledWith("job-1"));
    expect(refresh).toHaveBeenCalled();
  });

  it("prevents duplicate submission while retrying and shows a loading state", async () => {
    const user = userEvent.setup();
    vi.spyOn(bridge, "getBackgroundJob").mockResolvedValue(baseJob({ status: "failed" }));
    let resolveRetry!: (v: any) => void;
    const retrySpy = vi.spyOn(bridge, "retryBackgroundJob").mockReturnValue(new Promise((resolve) => { resolveRetry = resolve; }));
    render(await BackgroundJobDetail({ params: { id: "job-1" } }));
    await user.click(screen.getByText("Retry"));
    expect(screen.getByText("Retrying…")).toBeDisabled();
    await user.click(screen.getByText("Retrying…"));
    expect(retrySpy).toHaveBeenCalledTimes(1);
    resolveRetry({});
    await waitFor(() => expect(screen.getByText("Retry succeeded.")).toBeInTheDocument());
    expect(refresh).toHaveBeenCalled();
  });

  it("shows the backend's structured error message on retry failure", async () => {
    const user = userEvent.setup();
    vi.spyOn(bridge, "getBackgroundJob").mockResolvedValue(baseJob({ status: "failed" }));
    vi.spyOn(bridge, "retryBackgroundJob").mockRejectedValue(new Error("Job is locked by another worker"));
    render(await BackgroundJobDetail({ params: { id: "job-1" } }));
    await user.click(screen.getByText("Retry"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Job is locked by another worker");
  });
});
