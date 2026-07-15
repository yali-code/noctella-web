export type DatabaseDriver = "sqlite" | "postgres" | "supabase-postgres";
export type CutoverState = "SQLiteOnly" | "SupabasePreview" | "SupabaseStaging" | "CutoverReady" | "SupabasePrimary" | "RollbackMode";
export interface DatabaseRuntimeConfig { driver: DatabaseDriver; cutoverState: CutoverState; sqliteUrl: string; postgresConfigured: boolean; supabaseConfigured: boolean; executionEnabled: boolean; }
const SECRET_KEYS = ["DATABASE_URL","SUPABASE_DATABASE_URL","SUPABASE_SERVICE_ROLE_KEY","SUPABASE_ANON_KEY"];
export function redactSecrets(input: string): string { let out = input; for (const key of SECRET_KEYS) { const value = process.env[key]; if (value) out = out.split(value).join("[REDACTED]"); } return out.replace(/postgres(?:ql)?:\/\/[^\s]+/gi,"postgres://[REDACTED]"); }
export function getDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseRuntimeConfig {
  const raw = env.DATABASE_DRIVER ?? "sqlite";
  const driver = raw === "postgres" || raw === "supabase-postgres" || raw === "sqlite" ? raw : undefined;
  if (!driver) throw new Error(`Unsupported DATABASE_DRIVER: ${raw}`);
  const cutoverState = (env.DATABASE_CUTOVER_STATE as CutoverState | undefined) ?? "SQLiteOnly";
  const allowed: CutoverState[] = ["SQLiteOnly","SupabasePreview","SupabaseStaging","CutoverReady","SupabasePrimary","RollbackMode"];
  if (!allowed.includes(cutoverState)) throw new Error(`Unsupported DATABASE_CUTOVER_STATE: ${cutoverState}`);
  const postgresUrl = driver === "supabase-postgres" ? env.SUPABASE_DATABASE_URL : env.DATABASE_URL;
  if (driver !== "sqlite" && !postgresUrl) throw new Error(`${driver} requires a configured server-side database URL`);
  if (cutoverState === "SupabasePrimary" && env.DATABASE_SUPABASE_PRIMARY_VERIFIED !== "true") throw new Error("SupabasePrimary is blocked until readiness verification passes");
  if (env.DATABASE_DUAL_WRITE === "true") throw new Error("Dual-write mode is not supported");
  return { driver, cutoverState, sqliteUrl: env.DATABASE_URL ?? "./data/dev.sqlite", postgresConfigured: Boolean(env.DATABASE_URL && driver === "postgres"), supabaseConfigured: Boolean(env.SUPABASE_DATABASE_URL && env.SUPABASE_PROJECT_URL), executionEnabled: env.DATABASE_MIGRATION_EXECUTION_ENABLED === "true" };
}
export function safeDatabaseStatus(env: NodeJS.ProcessEnv = process.env) { const c = getDatabaseConfig(env); return { activeDriver: c.driver, cutoverState: c.cutoverState, postgresConfigured: c.postgresConfigured, supabaseConfigured: c.supabaseConfigured, migrationExecutionEnabled: c.executionEnabled }; }
