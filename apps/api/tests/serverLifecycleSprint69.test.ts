import { afterEach, describe, expect, it, vi } from "vitest";
import { createGracefulShutdown, resolvePort } from "../src/serverLifecycle";

afterEach(() => {
  vi.useRealTimers();
});

describe("resolvePort (Sprint 69)", () => {
  it("prefers PORT over API_PORT and the default, returning a number", () => {
    const port = resolvePort({ PORT: "8080", API_PORT: "5000" } as NodeJS.ProcessEnv);
    expect(port).toBe(8080);
    expect(typeof port).toBe("number");
  });

  it("falls back to API_PORT when PORT is unset (existing local-dev behavior)", () => {
    expect(resolvePort({ API_PORT: "5000" } as NodeJS.ProcessEnv)).toBe(5000);
  });

  it("falls back to 4000 when neither is set", () => {
    expect(resolvePort({} as NodeJS.ProcessEnv)).toBe(4000);
  });

  it("falls back to API_PORT when PORT is invalid (non-integer)", () => {
    expect(resolvePort({ PORT: "not-a-port", API_PORT: "5000" } as NodeJS.ProcessEnv)).toBe(5000);
  });

  it("falls back to API_PORT when PORT is zero", () => {
    expect(resolvePort({ PORT: "0", API_PORT: "5000" } as NodeJS.ProcessEnv)).toBe(5000);
  });

  it("falls back to API_PORT when PORT is negative", () => {
    expect(resolvePort({ PORT: "-1", API_PORT: "5000" } as NodeJS.ProcessEnv)).toBe(5000);
  });

  it("falls back to API_PORT when PORT is a non-integer decimal", () => {
    expect(resolvePort({ PORT: "3000.5", API_PORT: "5000" } as NodeJS.ProcessEnv)).toBe(5000);
  });

  it("falls back to API_PORT when PORT is out of the valid TCP port range", () => {
    expect(resolvePort({ PORT: "70000", API_PORT: "5000" } as NodeJS.ProcessEnv)).toBe(5000);
  });

  it("falls all the way through to 4000 when both PORT and API_PORT are invalid", () => {
    expect(resolvePort({ PORT: "abc", API_PORT: "-5" } as NodeJS.ProcessEnv)).toBe(4000);
  });

  it("accepts the boundary values 1 and 65535", () => {
    expect(resolvePort({ PORT: "1" } as NodeJS.ProcessEnv)).toBe(1);
    expect(resolvePort({ PORT: "65535" } as NodeJS.ProcessEnv)).toBe(65535);
  });
});

describe("createGracefulShutdown (Sprint 69)", () => {
  function deps(overrides: Partial<Parameters<typeof createGracefulShutdown>[0]> = {}) {
    const server = { close: vi.fn((cb: (err?: Error) => void) => cb()) };
    const dbRuntime = { shutdown: vi.fn().mockResolvedValue(undefined) };
    const log = vi.fn();
    const logError = vi.fn();
    const exit = vi.fn();
    return { server, dbRuntime, log, logError, exit, ...overrides };
  }

  it("closes the server, then shuts down the database runtime, then exits 0", async () => {
    vi.useFakeTimers();
    const d = deps();
    const shutdown = createGracefulShutdown(d);
    await shutdown("SIGTERM");
    expect(d.server.close).toHaveBeenCalledTimes(1);
    expect(d.dbRuntime.shutdown).toHaveBeenCalledTimes(1);
    expect(d.server.close.mock.invocationCallOrder[0]).toBeLessThan(
      d.dbRuntime.shutdown.mock.invocationCallOrder[0],
    );
    expect(d.log).toHaveBeenCalledWith("Shutdown complete");
    expect(d.exit).toHaveBeenCalledWith(0);
    expect(d.logError).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(d.exit).toHaveBeenCalledTimes(1);
  });

  it("is idempotent - a second signal does not close the server or shut down the database again", async () => {
    const d = deps();
    const shutdown = createGracefulShutdown(d);
    await shutdown("SIGTERM");
    await shutdown("SIGINT");
    expect(d.server.close).toHaveBeenCalledTimes(1);
    expect(d.dbRuntime.shutdown).toHaveBeenCalledTimes(1);
    expect(d.exit).toHaveBeenCalledTimes(1);
  });

  const SECRETS = [
    "pw=abc123",
    "postgres://user:hunter2@db.internal:5432/noctella",
    "Authorization: Bearer test-secret-value-abc123",
  ];

  it.each(SECRETS)(
    "logs only the fixed message (never the raw error) when server.close fails with a secret-like message (%s)",
    async (secret) => {
      vi.useFakeTimers();
      const d = deps({
        server: { close: vi.fn((cb: (err?: Error) => void) => cb(new Error(`close failed: ${secret}`))) },
      } as any);
      const shutdown = createGracefulShutdown(d);
      await shutdown("SIGTERM");
      expect(d.dbRuntime.shutdown).not.toHaveBeenCalled();
      expect(d.exit).toHaveBeenCalledWith(1);
      expect(d.logError).toHaveBeenCalledExactlyOnceWith("Error during shutdown");
      expect(JSON.stringify(d.logError.mock.calls[0])).not.toContain(secret);
      await vi.runAllTimersAsync();
      expect(d.exit).toHaveBeenCalledTimes(1);
    },
  );

  it.each(SECRETS)(
    "logs only the fixed message (never the raw error) when dbRuntime.shutdown() rejects with a secret-like message (%s)",
    async (secret) => {
      vi.useFakeTimers();
      const d = deps({
        dbRuntime: { shutdown: vi.fn().mockRejectedValue(new Error(`db shutdown failed: ${secret}`)) },
      } as any);
      const shutdown = createGracefulShutdown(d);
      await shutdown("SIGTERM");
      expect(d.exit).toHaveBeenCalledWith(1);
      expect(d.logError).toHaveBeenCalledExactlyOnceWith("Error during shutdown");
      expect(JSON.stringify(d.logError.mock.calls[0])).not.toContain(secret);
      await vi.runAllTimersAsync();
      expect(d.exit).toHaveBeenCalledTimes(1);
    },
  );

  it("times out a stalled server close and ignores its late callback", async () => {
    vi.useFakeTimers();
    let closeCallback: ((err?: Error) => void) | undefined;
    const d = deps({
      server: { close: vi.fn((callback: (err?: Error) => void) => { closeCallback = callback; }) },
      shutdownTimeoutMs: 10,
    });
    const shutdown = createGracefulShutdown(d);
    const pending = shutdown("SIGTERM");

    await vi.advanceTimersByTimeAsync(10);
    expect(d.logError).toHaveBeenCalledExactlyOnceWith("Error during shutdown");
    expect(d.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(d.dbRuntime.shutdown).not.toHaveBeenCalled();

    closeCallback?.();
    await pending;
    expect(d.dbRuntime.shutdown).not.toHaveBeenCalled();
    expect(d.log).not.toHaveBeenCalledWith("Shutdown complete");
    expect(d.logError).toHaveBeenCalledTimes(1);
    expect(d.exit).toHaveBeenCalledTimes(1);
  });

  it("times out a stalled database shutdown and ignores its late resolution", async () => {
    vi.useFakeTimers();
    let resolveDatabase!: () => void;
    const databasePending = new Promise<void>((resolve) => { resolveDatabase = resolve; });
    const d = deps({
      dbRuntime: { shutdown: vi.fn(() => databasePending) },
      shutdownTimeoutMs: 10,
    });
    const shutdown = createGracefulShutdown(d);
    const pending = shutdown("SIGTERM");

    await vi.advanceTimersByTimeAsync(10);
    expect(d.dbRuntime.shutdown).toHaveBeenCalledTimes(1);
    expect(d.logError).toHaveBeenCalledExactlyOnceWith("Error during shutdown");
    expect(d.exit).toHaveBeenCalledExactlyOnceWith(1);

    resolveDatabase();
    await pending;
    expect(d.log).not.toHaveBeenCalledWith("Shutdown complete");
    expect(d.logError).toHaveBeenCalledTimes(1);
    expect(d.exit).toHaveBeenCalledTimes(1);
  });

  it("ignores a late database rejection after the deadline", async () => {
    vi.useFakeTimers();
    let rejectDatabase!: (error: Error) => void;
    const databasePending = new Promise<void>((_resolve, reject) => { rejectDatabase = reject; });
    const d = deps({
      dbRuntime: { shutdown: vi.fn(() => databasePending) },
      shutdownTimeoutMs: 10,
    });
    const shutdown = createGracefulShutdown(d);
    const pending = shutdown("SIGTERM");

    await vi.advanceTimersByTimeAsync(10);
    rejectDatabase(new Error("postgres://user:secret@db.internal/noctella"));
    await pending;
    expect(d.logError).toHaveBeenCalledExactlyOnceWith("Error during shutdown");
    expect(d.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("remains idempotent while shutdown is pending", async () => {
    vi.useFakeTimers();
    const server = { close: vi.fn((_callback: (err?: Error) => void) => {}) };
    const d = deps({ server, shutdownTimeoutMs: 10 });
    const shutdown = createGracefulShutdown(d);
    void shutdown("SIGTERM");
    await shutdown("SIGINT");

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(d.dbRuntime.shutdown).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(d.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("defaults log/logError/exit to console/process.exit when not injected", async () => {
    const server = { close: vi.fn((cb: (err?: Error) => void) => cb()) };
    const dbRuntime = { shutdown: vi.fn().mockResolvedValue(undefined) };
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const shutdown = createGracefulShutdown({ server, dbRuntime });
    await shutdown("SIGTERM");
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });
});
