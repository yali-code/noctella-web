export type ShipmentRepositories = Record<string, unknown>;
export type SyncShipmentTransactionContext<R extends ShipmentRepositories = ShipmentRepositories> = { repositories: R; afterCommit: (fn: () => void | Promise<void>) => void };
export type AsyncShipmentTransactionContext<R extends ShipmentRepositories = ShipmentRepositories> = { repositories: R; afterCommit: (fn: () => void | Promise<void>) => void };
export type SyncShipmentTransactionCallback<T, R extends ShipmentRepositories = ShipmentRepositories> = (ctx: SyncShipmentTransactionContext<R>) => T;
export type AsyncShipmentTransactionCallback<T, R extends ShipmentRepositories = ShipmentRepositories> = (ctx: AsyncShipmentTransactionContext<R>) => T | Promise<T>;
const isPromiseLike = (v: unknown): v is Promise<unknown> => Boolean(v && typeof (v as any).then === "function");
export async function runAfterCommit(callbacks: Array<() => void | Promise<void>>) { for (const fn of callbacks) await fn(); }
export function createSqliteShipmentUnitOfWork<TDb, R extends ShipmentRepositories>(db: TDb & { transaction: Function }, createRepositories: (tx: TDb) => R) {
  return { run<T>(callback: SyncShipmentTransactionCallback<T, R>): T { const after: Array<() => void | Promise<void>> = []; let committed = false; const result = db.transaction((tx: TDb) => { const value = callback({ repositories: createRepositories(tx), afterCommit: (fn) => after.push(fn) }); if (isPromiseLike(value)) throw new Error("SQLite Shipment UnitOfWork callback must be synchronous"); return value; }); committed = true; if (committed) { for (const fn of after) { const value = fn(); if (isPromiseLike(value)) void value.catch(() => undefined); } } return result as T; } };
}
export function createPostgresShipmentUnitOfWork<TDb, R extends ShipmentRepositories>(db: TDb & { transaction: Function }, createRepositories: (tx: TDb) => R) {
  return { async run<T>(callback: AsyncShipmentTransactionCallback<T, R>): Promise<T> { const after: Array<() => void | Promise<void>> = []; const result = await db.transaction(async (tx: TDb) => callback({ repositories: createRepositories(tx), afterCommit: (fn) => after.push(fn) })); await runAfterCommit(after); return result as T; } };
}
