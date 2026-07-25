import type { RuntimeDb } from "./db/runtime";

/**
 * Only the one method this module actually calls - narrower than node:http's Server type so a
 * plain test double doesn't need to replicate Server.close()'s exact overload signature (which
 * returns `this`).
 */
export interface CloseableServer {
  close(callback: (err?: Error) => void): void;
}

const DEFAULT_PORT = 4000;
const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * Parses a base-10 integer TCP port from a raw env-var string, or undefined if the value is
 * missing/malformed (not a plain integer literal, zero, negative, or out of the valid TCP port
 * range) - callers treat undefined as "fall through to the next source" rather than throwing, so
 * a misconfigured higher-precedence variable never prevents startup.
 */
function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) return undefined;
  return parsed;
}

/**
 * Sprint 69: Render assigns the port to bind via PORT (always a numeric-string env var) - takes
 * priority over the existing API_PORT local-dev convention, which in turn falls back to 4000
 * (unchanged local behavior). Always returns a valid numeric TCP port.
 */
export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  return parsePort(env.PORT) ?? parsePort(env.API_PORT) ?? DEFAULT_PORT;
}

export interface ShutdownDeps {
  server: CloseableServer;
  dbRuntime: Pick<RuntimeDb, "shutdown">;
  log?: (...args: unknown[]) => void;
  logError?: (...args: unknown[]) => void;
  exit?: (code: number) => void;
}

/**
 * Creates an idempotent SIGTERM/SIGINT handler: stops accepting new connections and drains
 * in-flight requests via server.close(), then shuts down the database runtime - dbRuntime.
 * shutdown() (db/runtime.ts) already knows how to close both the sqlite handle and a postgres
 * pool, so this never reimplements that. The `shuttingDown` guard is what makes the overall flow
 * idempotent: a second signal while shutdown is already in progress (or after it completed) is a
 * no-op rather than calling server.close()/dbRuntime.shutdown() a second time, since neither of
 * those is safe to call twice on its own.
 */
export function createGracefulShutdown({
  server,
  dbRuntime,
  log = console.log,
  logError = console.error,
  exit = process.exit,
}: ShutdownDeps) {
  let shuttingDown = false;
  return async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Received ${signal}, shutting down gracefully`);
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await dbRuntime.shutdown();
      log("Shutdown complete");
      exit(0);
    } catch {
      // A shutdown failure's raw error/message could embed a connection string or token (e.g. a
      // postgres pool error) - deliberately never touched, not even via a redactor. Fixed
      // operational message only.
      logError("Error during shutdown");
      exit(1);
    }
  };
}
