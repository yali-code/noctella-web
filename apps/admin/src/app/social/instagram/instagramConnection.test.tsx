// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { api, ApiError } from "@/lib/api";
import { instagramConnectionApi, INSTAGRAM_SCOPES } from "@/lib/instagramConnection";
import { socialContentApi } from "@/lib/socialContent";
import InstagramConnectionPage from "./page";

const TOKEN = "test-only-token-value";
const connection = { id: "c1", channel: "instagram", accountLabel: "vault", externalAccountId: "17841400000000000", status: "connected",
  scopes: [...INSTAGRAM_SCOPES], tokenExpiresAt: null, updatedAt: "2026-10-07T10:00:00Z" };
const readiness = { ready: false, mediaOriginAllowed: true, connection: "missing", missingConfiguration: ["INSTAGRAM_API_VERSION"], checks: {} };
beforeEach(() => {
  vi.spyOn(instagramConnectionApi, "get").mockResolvedValue(null);
  vi.spyOn(instagramConnectionApi, "store").mockResolvedValue(connection);
  vi.spyOn(instagramConnectionApi, "verify").mockResolvedValue(connection);
  vi.spyOn(socialContentApi, "publishingReadiness").mockResolvedValue(readiness);
  // Any other request (including a direct publish) would be a bug.
  vi.spyOn(api, "post").mockRejectedValue(new Error("Unexpected API mutation"));
  vi.spyOn(window.localStorage.__proto__, "setItem");
  vi.spyOn(window.sessionStorage.__proto__, "setItem");
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const tokenInput = () => screen.getByLabelText("Long-lived access token") as HTMLInputElement;

describe("Instagram connection administration", () => {
  it("reads only local state on page load and never verifies passively", async () => {
    render(<InstagramConnectionPage />);
    expect(await screen.findByText("No connection stored.")).toBeInTheDocument();
    expect(await screen.findByText(/Missing or invalid configuration: INSTAGRAM_API_VERSION/)).toBeInTheDocument();
    expect(instagramConnectionApi.get).toHaveBeenCalledOnce();
    expect(instagramConnectionApi.verify).not.toHaveBeenCalled();
    expect(instagramConnectionApi.store).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Verify connection" })).not.toBeInTheDocument();
    expect(tokenInput()).toHaveAttribute("type", "password");
  });
  it("stores the token explicitly, clears it, and never redisplays or persists it", async () => {
    render(<InstagramConnectionPage />);
    await screen.findByText("No connection stored.");
    vi.mocked(instagramConnectionApi.get).mockResolvedValue(connection);
    fireEvent.change(tokenInput(), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: "Store connection" }));
    await waitFor(() => expect(instagramConnectionApi.store).toHaveBeenCalledWith(TOKEN, null));
    expect(await screen.findByText(/Connection stored/)).toBeInTheDocument();
    expect(tokenInput().value).toBe("");
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(screen.getByText(`Scopes: ${INSTAGRAM_SCOPES.join(", ")}`)).toBeInTheDocument();
    expect(instagramConnectionApi.verify).not.toHaveBeenCalled();
    expect(window.localStorage.setItem).not.toHaveBeenCalled();
    expect(window.sessionStorage.setItem).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });
  it("shows a safe error that never contains the submitted token", async () => {
    vi.mocked(instagramConnectionApi.store).mockRejectedValue(new ApiError("Instagram authorization error", 403));
    render(<InstagramConnectionPage />);
    await screen.findByText("No connection stored.");
    fireEvent.change(tokenInput(), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: "Store connection" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Instagram authorization error");
    expect(tokenInput().value).toBe("");
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });
  it("verifies only when the operator clicks Verify connection", async () => {
    vi.mocked(instagramConnectionApi.get).mockResolvedValue(connection);
    render(<InstagramConnectionPage />);
    const button = await screen.findByRole("button", { name: "Verify connection" });
    expect(instagramConnectionApi.verify).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(instagramConnectionApi.verify).toHaveBeenCalledOnce());
    expect(await screen.findByText(/Connection verified/)).toBeInTheDocument();
    expect(instagramConnectionApi.store).not.toHaveBeenCalled();
  });
  it("maps store and verify to their intended endpoints only", async () => {
    vi.mocked(instagramConnectionApi.store).mockRestore();
    vi.mocked(instagramConnectionApi.verify).mockRestore();
    vi.mocked(api.post).mockResolvedValue(connection as any);
    await instagramConnectionApi.store(TOKEN, null);
    expect(api.post).toHaveBeenCalledWith("/api/instagram/connection", { accessToken: TOKEN, scopes: INSTAGRAM_SCOPES });
    await instagramConnectionApi.verify();
    expect(api.post).toHaveBeenLastCalledWith("/api/instagram/connection/verify", {});
    expect(api.post).toHaveBeenCalledTimes(2);
  });
  it("tolerates readiness being unavailable for the role", async () => {
    vi.mocked(socialContentApi.publishingReadiness).mockRejectedValue(new ApiError("Forbidden", 403));
    render(<InstagramConnectionPage />);
    expect(await screen.findByText(/not available for your role/)).toBeInTheDocument();
  });
});
