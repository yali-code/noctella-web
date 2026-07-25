import { describe, expect, it, vi } from "vitest";
import { runBackgroundJobsOnce } from "../src/scripts/runBackgroundJobs";

const TOKEN = "super-secret-scheduler-token-do-not-log";

describe("runBackgroundJobsOnce (Sprint 69)", () => {
  it("fails closed before making any request when API_HOSTPORT is missing", async () => {
    const fetchImpl = vi.fn();
    const result = await runBackgroundJobsOnce({ SCHEDULER_AUTH_TOKEN: TOKEN } as NodeJS.ProcessEnv, fetchImpl);
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed before making any request when SCHEDULER_AUTH_TOKEN is missing", async () => {
    const fetchImpl = vi.fn();
    const result = await runBackgroundJobsOnce({ API_HOSTPORT: "noctella-staging-api:10000" } as NodeJS.ProcessEnv, fetchImpl);
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed when both are missing", async () => {
    const fetchImpl = vi.fn();
    const result = await runBackgroundJobsOnce({} as NodeJS.ProcessEnv, fetchImpl);
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts to the exact expected URL with the exact expected headers and body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const env = { API_HOSTPORT: "noctella-staging-api:10000", SCHEDULER_AUTH_TOKEN: TOKEN } as NodeJS.ProcessEnv;

    await runBackgroundJobsOnce(env, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://noctella-staging-api:10000/api/background-jobs/run");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body)).toEqual({ workerId: "render-staging-cron", batchSize: 10 });
  });

  it("returns ok:true on a successful (2xx) response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ processed: 3 }), { status: 200 }));
    const result = await runBackgroundJobsOnce(
      { API_HOSTPORT: "noctella-staging-api:10000", SCHEDULER_AUTH_TOKEN: TOKEN } as NodeJS.ProcessEnv,
      fetchImpl,
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  it("returns ok:false with the response status on a non-2xx response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
    const result = await runBackgroundJobsOnce(
      { API_HOSTPORT: "noctella-staging-api:10000", SCHEDULER_AUTH_TOKEN: TOKEN } as NodeJS.ProcessEnv,
      fetchImpl,
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
  });

  it("returns ok:false with a fixed safe message on a network failure, never the raw error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const result = await runBackgroundJobsOnce(
      { API_HOSTPORT: "noctella-staging-api:10000", SCHEDULER_AUTH_TOKEN: TOKEN } as NodeJS.ProcessEnv,
      fetchImpl,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Background job run request failed");
  });

  it("regression: a network error whose message embeds the Authorization header never leaks the token", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn().mockRejectedValue(new Error(`Authorization: Bearer ${TOKEN}`));
    const env = { API_HOSTPORT: "noctella-staging-api:10000", SCHEDULER_AUTH_TOKEN: TOKEN } as NodeJS.ProcessEnv;

    const result = await runBackgroundJobsOnce(env, fetchImpl);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Background job run request failed");
    expect(JSON.stringify(result)).not.toContain(TOKEN);

    const allLoggedText = JSON.stringify([...logSpy.mock.calls, ...errorSpy.mock.calls]);
    expect(allLoggedText).not.toContain(TOKEN);
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("never includes the scheduler token in a returned error message, even on failure", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed: connection refused"));
    const env = { API_HOSTPORT: "noctella-staging-api:10000", SCHEDULER_AUTH_TOKEN: TOKEN } as NodeJS.ProcessEnv;

    const missingConfigResult = await runBackgroundJobsOnce({} as NodeJS.ProcessEnv, fetchImpl);
    const networkFailureResult = await runBackgroundJobsOnce(env, fetchImpl);
    const nonOkResult = await runBackgroundJobsOnce(env, vi.fn().mockResolvedValue(new Response("{}", { status: 500 })));

    for (const result of [missingConfigResult, networkFailureResult, nonOkResult]) {
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    }
  });

  it("never logs the scheduler token to the console", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const env = { API_HOSTPORT: "noctella-staging-api:10000", SCHEDULER_AUTH_TOKEN: TOKEN } as NodeJS.ProcessEnv;

    await runBackgroundJobsOnce(env, fetchImpl);

    const allLoggedText = JSON.stringify([...logSpy.mock.calls, ...errorSpy.mock.calls]);
    expect(allLoggedText).not.toContain(TOKEN);
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
