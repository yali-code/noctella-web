import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  let resolveBootstrap: (() => void) | undefined;
  let rejectBootstrap: ((error: Error) => void) | undefined;
  return {
    order: [] as string[],
    listen: vi.fn(),
    error: vi.fn(),
    bootstrap: vi.fn(),
    reset() {
      this.order.length = 0;
      this.listen.mockReset();
      this.error.mockReset();
      this.bootstrap.mockReset();
      this.bootstrap.mockImplementation(() => new Promise<void>((resolve, reject) => {
        resolveBootstrap = resolve;
        rejectBootstrap = reject;
        this.order.push("bootstrap");
      }));
    },
    resolveBootstrap() { resolveBootstrap?.(); },
    rejectBootstrap(error: Error) { rejectBootstrap?.(error); },
  };
});

vi.mock("../src/config/productionConfig", () => ({
  ProductionConfigurationError: class ProductionConfigurationError extends Error {},
  validateProductionApiConfig: () => { state.order.push("validate"); },
}));
vi.mock("../src/app", () => ({
  default: { listen: (...args: unknown[]) => { state.order.push("listen"); return state.listen(...args); } },
}));
vi.mock("../src/db/client", () => ({ db: {}, dbRuntime: {} }));
vi.mock("../src/services/categories", () => ({
  seedInitialCategoriesIfEmpty: (...args: unknown[]) => state.bootstrap(...args),
}));
vi.mock("../src/serverLifecycle", () => ({
  resolvePort: () => 10000,
  createGracefulShutdown: () => vi.fn(),
}));

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for startup state");
}

describe("Sprint 164 category bootstrap startup boundary", () => {
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    vi.resetModules();
    state.reset();
    process.exitCode = originalExitCode;
    vi.spyOn(console, "error").mockImplementation((...args) => state.error(...args));
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it("validates first and does not listen until bootstrap resolves", async () => {
    await import("../src/index");
    await waitFor(() => state.bootstrap.mock.calls.length === 1);
    expect(state.order).toEqual(["validate", "bootstrap"]);
    expect(state.listen).not.toHaveBeenCalled();

    state.resolveBootstrap();
    await waitFor(() => state.listen.mock.calls.length === 1);
    expect(state.order).toEqual(["validate", "bootstrap", "listen"]);
  });

  it("fails startup safely without listening or exposing the bootstrap error", async () => {
    const secret = "postgres://admin:secret@db/private.sqlite SQL INSERT categories";
    await import("../src/index");
    await waitFor(() => state.bootstrap.mock.calls.length === 1);
    state.rejectBootstrap(new Error(secret));
    await waitFor(() => process.exitCode === 1);

    expect(state.listen).not.toHaveBeenCalled();
    expect(state.error).toHaveBeenCalledWith("API startup failed");
    expect(JSON.stringify(state.error.mock.calls)).not.toContain(secret);
  });
});
