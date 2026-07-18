import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { createSalesRepositoriesForDb } from "../src/repositories/sales/factory";
import type { SalesRepositories } from "../src/repositories/sales/types";
import {
  buildSalesApplicationContext,
  type BuildSalesApplicationContextInput,
} from "../src/services/salesApplicationContext";
import { createSalesApplicationContextForDb } from "../src/services/salesApplicationContextForDb";
import { SqliteUnitOfWork } from "../src/services/unitOfWork";
import {
  auditSalesApplicationContextSource,
  auditSalesApplicationContextFactorySource,
  runSalesApplicationContextAudit,
} from "../src/scripts/salesApplicationContextAudit";

function repositories(): SalesRepositories {
  return { saleRepository: { create: ((x: unknown) => x) as never, findById: (() => null) as never, findByReference: (() => null) as never, findByExternalOrderId: (() => null) as never, findByIdempotencyKey: (() => null) as never, list: (() => ({ rows: [], total: 0, limit: 50, offset: 0 })) as never, update: (() => null) as never, updateWithVersion: (() => ({ ok: false, issue: { code: "not_found", message: "x" } })) as never, addLine: ((x: unknown) => x) as never, updateLine: (() => null) as never, removeLine: (() => false) as never } };
}
function deps(): BuildSalesApplicationContextInput { return { salesRepositories: repositories(), unitOfWork: { run: (async (work: (context: { repositories: Record<string, never> }) => unknown) => work({ repositories: {} })) as never }, logger: {}, clock: { now: () => new Date("2026-01-01T00:00:00.000Z") }, idGenerator: { newId: () => "id-1" } }; }
function db() { const raw = new Database(":memory:"); ensureSchema(raw); const d = drizzle(raw, { schema }); return { raw, db: d }; }
const clean = "Object.freeze({ salesRepositories, saleRepository, unitOfWork, logger, clock, idGenerator, configuration });";

describe("Sales application context Sprint 33A-S2", () => {
  const cases: Array<[string, () => void | Promise<void>]> = [
    ["builds context", () => expect(buildSalesApplicationContext(deps())).toBeTruthy()],
    ["freezes context", () => expect(Object.isFrozen(buildSalesApplicationContext(deps()))).toBe(true)],
    ["freezes repository bundle", () => expect(Object.isFrozen(buildSalesApplicationContext(deps()).salesRepositories)).toBe(true)],
    ["exposes salesRepositories", () => { const d = deps(); expect(buildSalesApplicationContext(d).salesRepositories.saleRepository).toBe(d.salesRepositories.saleRepository); }],
    ["exposes saleRepository", () => { const d = deps(); expect(buildSalesApplicationContext(d).saleRepository).toBe(d.salesRepositories.saleRepository); }],
    ["exposes UnitOfWork", () => { const d = deps(); expect(buildSalesApplicationContext(d).unitOfWork).toBe(d.unitOfWork); }],
    ["exposes logger", () => { const d = { ...deps(), logger: { info: () => undefined } }; expect(buildSalesApplicationContext(d).logger).toBe(d.logger); }],
    ["exposes clock", () => expect(buildSalesApplicationContext(deps()).clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z")],
    ["exposes idGenerator", () => expect(buildSalesApplicationContext(deps()).idGenerator.newId()).toBe("id-1")],
    ["exposes default configuration", () => expect(buildSalesApplicationContext(deps()).configuration).toEqual({ salesApplicationContext: true })],
    ["freezes default configuration", () => expect(Object.isFrozen(buildSalesApplicationContext(deps()).configuration)).toBe(true)],
    ["preserves provided configuration values", () => { const c = { salesApplicationContext: true as const, driver: "sqlite" }; expect(buildSalesApplicationContext({ ...deps(), configuration: c }).configuration).toEqual(c); }],
    ["freezes provided configuration", () => { const c = { salesApplicationContext: true as const, driver: "sqlite" }; expect(Object.isFrozen(buildSalesApplicationContext({ ...deps(), configuration: c }).configuration)).toBe(true); }],
    ["copies provided configuration", () => { const c = { salesApplicationContext: true as const, driver: "sqlite" }; expect(buildSalesApplicationContext({ ...deps(), configuration: c }).configuration).not.toBe(c); }],
    ["configuration mutation cannot alter values", () => { const c = buildSalesApplicationContext({ ...deps(), configuration: { salesApplicationContext: true, driver: "sqlite" } }).configuration as { driver?: string }; expect(() => { c.driver = "postgres"; }).toThrow(); expect(c.driver).toBe("sqlite"); }],
    ["requires salesRepositories", () => { const d = deps() as Partial<Record<keyof BuildSalesApplicationContextInput, unknown>>; delete d.salesRepositories; expect(() => buildSalesApplicationContext(d as never)).toThrow("SALES_APPLICATION_CONTEXT_MISSING_salesRepositories"); }],
    ["requires saleRepository", () => { const d = deps() as BuildSalesApplicationContextInput & { salesRepositories: SalesRepositories }; d.salesRepositories = {} as never; expect(() => buildSalesApplicationContext(d)).toThrow("SALES_APPLICATION_CONTEXT_MISSING_REPOSITORY_saleRepository"); }],
    ["requires UnitOfWork", () => { const d = deps() as Partial<Record<keyof BuildSalesApplicationContextInput, unknown>>; delete d.unitOfWork; expect(() => buildSalesApplicationContext(d as never)).toThrow("SALES_APPLICATION_CONTEXT_MISSING_unitOfWork"); }],
    ["requires logger", () => { const d = deps() as Partial<Record<keyof BuildSalesApplicationContextInput, unknown>>; delete d.logger; expect(() => buildSalesApplicationContext(d as never)).toThrow("SALES_APPLICATION_CONTEXT_MISSING_logger"); }],
    ["requires clock", () => { const d = deps() as Partial<Record<keyof BuildSalesApplicationContextInput, unknown>>; delete d.clock; expect(() => buildSalesApplicationContext(d as never)).toThrow("SALES_APPLICATION_CONTEXT_MISSING_clock"); }],
    ["requires idGenerator", () => { const d = deps() as Partial<Record<keyof BuildSalesApplicationContextInput, unknown>>; delete d.idGenerator; expect(() => buildSalesApplicationContext(d as never)).toThrow("SALES_APPLICATION_CONTEXT_MISSING_idGenerator"); }],
    ["context cannot be reassigned", () => { const c = buildSalesApplicationContext(deps()) as never as { logger: unknown }; expect(() => { c.logger = null; }).toThrow(); }],
    ["bundle cannot be reassigned", () => { const c = buildSalesApplicationContext(deps()) as never as { salesRepositories: { saleRepository: unknown } }; expect(() => { c.salesRepositories.saleRepository = null; }).toThrow(); }],
    ["creates distinct contexts", () => expect(buildSalesApplicationContext(deps())).not.toBe(buildSalesApplicationContext(deps()))],
    ["copies repository bundle", () => { const d = deps(); expect(buildSalesApplicationContext(d).salesRepositories).not.toBe(d.salesRepositories); }],
    ["does not clone repository", () => { const d = deps(); expect(buildSalesApplicationContext(d).saleRepository).toBe(d.salesRepositories.saleRepository); }],
    ["only expected context keys", () => expect(Object.keys(buildSalesApplicationContext(deps())).sort()).toEqual(["clock", "configuration", "idGenerator", "logger", "saleRepository", "salesRepositories", "unitOfWork"].sort())],
    ["only expected repository keys", () => expect(Object.keys(buildSalesApplicationContext(deps()).salesRepositories)).toEqual(["saleRepository"])],
    ["no event publisher", () => expect("eventPublisher" in buildSalesApplicationContext(deps())).toBe(false)],
    ["no observability", () => expect("observability" in buildSalesApplicationContext(deps())).toBe(false)],
    ["builder has no Date.now", () => expect(buildSalesApplicationContext.toString()).not.toContain("Date.now")],
    ["builder has no randomUUID", () => expect(buildSalesApplicationContext.toString()).not.toContain("randomUUID")],
    ["SQLite factory wires repository", () => { const h = db(); try { const c = createSalesApplicationContextForDb({ db: h.db, driver: "sqlite", logger: {}, clock: deps().clock, idGenerator: deps().idGenerator }); expect(c.saleRepository.findById("missing")).toBeNull(); } finally { h.raw.close(); } }],
    ["SQLite factory freezes context", () => { const h = db(); try { expect(Object.isFrozen(createSalesApplicationContextForDb({ db: h.db, driver: "sqlite", logger: {}, clock: deps().clock, idGenerator: deps().idGenerator }))).toBe(true); } finally { h.raw.close(); } }],
    ["SQLite factory freezes bundle", () => { const h = db(); try { expect(Object.isFrozen(createSalesApplicationContextForDb({ db: h.db, driver: "sqlite", logger: {}, clock: deps().clock, idGenerator: deps().idGenerator }).salesRepositories)).toBe(true); } finally { h.raw.close(); } }],
    ["SQLite factory exposes UnitOfWork", () => { const h = db(); try { expect(createSalesApplicationContextForDb({ db: h.db, driver: "sqlite", logger: {}, clock: deps().clock, idGenerator: deps().idGenerator }).unitOfWork).toBeInstanceOf(SqliteUnitOfWork); } finally { h.raw.close(); } }],
    ["SQLite factory accepts UnitOfWork", () => { const h = db(); const u = deps().unitOfWork; try { expect(createSalesApplicationContextForDb({ db: h.db, driver: "sqlite", unitOfWork: u, logger: {}, clock: deps().clock, idGenerator: deps().idGenerator }).unitOfWork).toBe(u); } finally { h.raw.close(); } }],
    ["SQLite factory carries driver", () => { const h = db(); try { expect(createSalesApplicationContextForDb({ db: h.db, driver: "sqlite", logger: {}, clock: deps().clock, idGenerator: deps().idGenerator }).configuration.driver).toBe("sqlite"); } finally { h.raw.close(); } }],
    ["test-memory factory selects SQLite repository", () => { const h = db(); try { const c = createSalesApplicationContextForDb({ db: h.db, driver: "test-memory", logger: {}, clock: deps().clock, idGenerator: deps().idGenerator }); expect(c.saleRepository.findById("missing")).toBeNull(); expect(c.configuration.driver).toBe("test-memory"); } finally { h.raw.close(); } }],
    ["PostgreSQL factory smoke", () => { const h = db(); try { const c = createSalesApplicationContextForDb({ db: h.db, driver: "postgres", logger: {}, clock: deps().clock, idGenerator: deps().idGenerator, unitOfWork: deps().unitOfWork }); expect(c.saleRepository.findById("missing")).toBeNull(); } finally { h.raw.close(); } }],
    ["PostgreSQL factory carries driver", () => { const h = db(); try { expect(createSalesApplicationContextForDb({ db: h.db, driver: "postgres", logger: {}, clock: deps().clock, idGenerator: deps().idGenerator, unitOfWork: deps().unitOfWork }).configuration.driver).toBe("postgres"); } finally { h.raw.close(); } }],
    ["Supabase PostgreSQL factory selection", () => { const h = db(); try { const c = createSalesApplicationContextForDb({ db: h.db, driver: "supabase-postgres", logger: {}, clock: deps().clock, idGenerator: deps().idGenerator, unitOfWork: deps().unitOfWork }); expect(c.saleRepository.findById("missing")).toBeNull(); expect(c.configuration.driver).toBe("supabase-postgres"); } finally { h.raw.close(); } }],
    ["DB factory preserves logger", () => { const h = db(); const logger = { info: () => undefined }; try { expect(createSalesApplicationContextForDb({ db: h.db, driver: "sqlite", logger, clock: deps().clock, idGenerator: deps().idGenerator }).logger).toBe(logger); } finally { h.raw.close(); } }],
    ["DB factory preserves clock", () => { const h = db(); const clock = deps().clock; try { expect(createSalesApplicationContextForDb({ db: h.db, driver: "sqlite", logger: {}, clock, idGenerator: deps().idGenerator }).clock).toBe(clock); } finally { h.raw.close(); } }],
    ["DB factory preserves id generator", () => { const h = db(); const idGenerator = deps().idGenerator; try { expect(createSalesApplicationContextForDb({ db: h.db, driver: "sqlite", logger: {}, clock: deps().clock, idGenerator }).idGenerator).toBe(idGenerator); } finally { h.raw.close(); } }],
    ["DB factory exposes no database client", () => { const h = db(); try { const c = createSalesApplicationContextForDb({ db: h.db, driver: "sqlite", logger: {}, clock: deps().clock, idGenerator: deps().idGenerator }); expect(Object.keys(c)).not.toContain("db"); expect(Object.keys(c)).not.toContain("client"); } finally { h.raw.close(); } }],
    ["factory uses S1 factory immutable bundle", () => { const h = db(); try { expect(Object.isFrozen(createSalesRepositoriesForDb(h.db, "sqlite"))).toBe(true); } finally { h.raw.close(); } }],
    ["factory exposes same sale repository as bundle", () => { const h = db(); try { const c = createSalesApplicationContextForDb({ db: h.db, driver: "sqlite", logger: {}, clock: deps().clock, idGenerator: deps().idGenerator }); expect(c.saleRepository).toBe(c.salesRepositories.saleRepository); } finally { h.raw.close(); } }],
    ["legacy sale repository remains compatible", () => { const h = db(); try { expect(createSalesRepositoriesForDb(h.db, "sqlite").saleRepository.findById("x")).toBeNull(); } finally { h.raw.close(); } }],
    ["audit production passes", () => expect(runSalesApplicationContextAudit().status).toBe("PASS")],
    ["audit clean fixture passes", () => expect(auditSalesApplicationContextSource(clean).status).toBe("PASS")],
    ["audit rejects SQL", () => expect(auditSalesApplicationContextSource("select * from sales Object.freeze({})").issues).toContain("SQL")],
    ["audit rejects DbClient", () => expect(auditSalesApplicationContextSource("type X = DbClient Object.freeze({})").issues).toContain("DbClient")],
    ["audit rejects Drizzle", () => expect(auditSalesApplicationContextSource("Drizzle Object.freeze({})").issues).toContain("Drizzle")],
    ["audit rejects HTTP", () => expect(auditSalesApplicationContextSource("fetch('/x') Object.freeze({})").issues).toContain("HTTP")],
    ["audit rejects Request", () => expect(auditSalesApplicationContextSource("Request Object.freeze({})").issues).toContain("HTTP")],
    ["audit rejects Response", () => expect(auditSalesApplicationContextSource("Response Object.freeze({})").issues).toContain("HTTP")],
    ["audit rejects routes", () => expect(auditSalesApplicationContextSource("routes Object.freeze({})").issues).toContain("routes")],
    ["audit rejects controllers", () => expect(auditSalesApplicationContextSource("controllers Object.freeze({})").issues).toContain("controllers")],
    ["audit rejects provider SDK", () => expect(auditSalesApplicationContextSource("stripe Object.freeze({})").issues).toContain("provider SDK")],
    ["audit rejects marketplace SDK", () => expect(auditSalesApplicationContextSource("shopify Object.freeze({})").issues).toContain("marketplace SDK")],
    ["audit rejects EventEmitter", () => expect(auditSalesApplicationContextSource("EventEmitter Object.freeze({})").issues).toContain("EventEmitter")],
    ["audit rejects Kafka", () => expect(auditSalesApplicationContextSource("Kafka Object.freeze({})").issues).toContain("Kafka")],
    ["audit rejects RabbitMQ", () => expect(auditSalesApplicationContextSource("RabbitMQ Object.freeze({})").issues).toContain("RabbitMQ")],
    ["audit rejects SNS", () => expect(auditSalesApplicationContextSource("SNS Object.freeze({})").issues).toContain("SNS")],
    ["audit rejects Azure", () => expect(auditSalesApplicationContextSource("Azure Object.freeze({})").issues).toContain("Azure")],
    ["audit rejects OpenTelemetry", () => expect(auditSalesApplicationContextSource("OpenTelemetry Object.freeze({})").issues).toContain("OpenTelemetry")],
    ["audit rejects Date.now", () => expect(auditSalesApplicationContextSource("Date.now Object.freeze({})").issues).toContain("Date.now")],
    ["audit rejects randomUUID", () => expect(auditSalesApplicationContextSource("randomUUID Object.freeze({})").issues).toContain("randomUUID")],
    ["audit rejects Math.random", () => expect(auditSalesApplicationContextSource("Math.random Object.freeze({})").issues).toContain("Math.random")],
    ["audit rejects schema imports", () => expect(auditSalesApplicationContextSource("import * as schema from '../db/schema' Object.freeze({})").issues).toContain("schema")],
    ["audit rejects repository implementations", () => expect(auditSalesApplicationContextSource("import x from '../repositories/sales/sqlite' Object.freeze({})").issues).toContain("repository implementation")],
    ["audit rejects mutable context construction", () => expect(auditSalesApplicationContextSource("let context = {} Object.freeze({})").issues).toContain("mutable context")],
    ["audit rejects transaction implementation leakage", () => expect(auditSalesApplicationContextSource("new SqliteUnitOfWork(x) Object.freeze({})").issues).toContain("transaction implementation")],
    ["audit rejects environment access", () => expect(auditSalesApplicationContextSource("process.env.X Object.freeze({})").issues).toContain("environment access")],
    ["factory audit accepts abstraction return", () => expect(auditSalesApplicationContextFactorySource("function createSalesApplicationContextForDb(input: Input): SalesApplicationContext { return build(input); }").status).toBe("PASS")],
    ["factory audit rejects DB return contract", () => expect(auditSalesApplicationContextFactorySource("function createSalesApplicationContextForDb(input: Input): DbClient { return input.db; }").issues).toContain("DB type in return contract")],
    ["factory audit rejects DB implementation leakage", () => expect(auditSalesApplicationContextFactorySource("function createSalesApplicationContextForDb(input: Input): SalesApplicationContext { return Object.freeze({ db: input.db }); }").issues).toContain("DB implementation leakage")],
  ];
  it.each(cases)("%s", async (_name, run) => { await run(); });
});
