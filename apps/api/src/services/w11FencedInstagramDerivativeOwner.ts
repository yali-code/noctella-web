import { randomUUID } from "node:crypto";
import { link, mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { sql, type SQL } from "drizzle-orm";
import type { DbClient } from "../db/client";
import { productPhotoStaticRoot } from "./photoStorage";
import { renderInstagramDerivative, sourceFingerprint, type InstagramImageRecipe } from "../integrations/instagram/mediaPreparation";
import { fileProof, inOwnershipTransaction, nowMs, ownershipDriver, photoOperationPrivateRoot, uniqueViolation, type OwnershipDriver, type Rows } from "./photoOperationAuthority";

/**
 * FAZ A / #424 W11 - INACTIVE PROPOSAL. Not imported by any production code path; the live W11 writer
 * (integrations/instagram/mediaPreparation.ts) keeps refusing with ownership fencing ON. It needs the additive
 * tables in docs/engineering/proposed-photo-ownership/0042_photo_derivative_operations.sql.proposal, which require
 * owner approval (schema + migration numbering) before this may be wired.
 *
 * Generation-fenced W11 derivative: one operation per content-addressed derivative key
 * (`${recipe}-${sha256(filename \0 source)}.jpg`, so a changed source is a different operation). Claim (create /
 * committed / review / in progress / reclaim after expiry, database time) -> the shared W11 recipe into an exclusive
 * generation-private directory -> seal (hash + inode) under the fence -> verified link()-only publication with
 * post-link checks (anything unexpected -> review, never replaced) -> CAS commit. W11 has no photo row or outbox
 * event, so the commit CAS is its only database effect. Nothing here deletes canonical bytes.
 */
export const W11_LEASE_MS = 5 * 60_000;
interface Owned { id: string; generation: number; owner: string; nonce: string; key: string }
type Claim = { kind: "owned"; op: Owned } | { kind: "committed"; key: string; sealSha256: string } | { kind: "in-progress" | "review" | "conflict" };
export class W11OperationRefusedError extends Error {
  constructor(readonly code: "W11_OPERATION_IN_PROGRESS" | "W11_OPERATION_REVIEW" | "W11_OPERATION_CONFLICT" | "W11_OPERATION_FENCE_LOST") { super(code); }
}
export interface W11Hooks { afterSeal?: () => void | Promise<void>; afterPublish?: () => void | Promise<void>; afterCommit?: () => void | Promise<void> }

function* claimSteps(driver: OwnershipDriver, key: string, sourceKey: string, fingerprint: string, recipe: string, ttl: number): Generator<SQL, Claim, Rows> {
  const now = nowMs(driver);
  const lock = sql.raw(driver === "postgres" ? " FOR UPDATE" : "");
  const [op] = yield sql`SELECT id, generation, state, source_key, source_fingerprint, recipe, seal_sha256, CASE WHEN lease_until_ms <= ${now} THEN 1 ELSE 0 END AS expired FROM photo_derivative_operations WHERE derivative_key = ${key}${lock}`;
  if (op) {
    if (op.source_key !== sourceKey || op.source_fingerprint !== fingerprint || op.recipe !== recipe) return { kind: "conflict" };
    if (op.state === "committed") return { kind: "committed", key, sealSha256: op.seal_sha256 };
    if (op.state === "review") return { kind: "review" };
    if (Number(op.expired) !== 1) return { kind: "in-progress" };
    const generation = Number(op.generation), next = generation + 1, owner = randomUUID(), nonce = randomUUID();
    const reclaimed = yield sql`UPDATE photo_derivative_operations SET generation = ${next}, owner = ${owner}, nonce = ${nonce}, state = 'preparing', seal_sha256 = NULL, seal_bytes = NULL, seal_dev = NULL, seal_ino = NULL, lease_until_ms = ${now} + ${ttl}, updated_ms = ${now}
      WHERE id = ${op.id} AND generation = ${generation} AND state IN ('preparing', 'sealed') AND lease_until_ms <= ${now} RETURNING id`;
    if (reclaimed.length !== 1) return { kind: "in-progress" };
    yield sql`UPDATE photo_derivative_operation_generations SET state = 'superseded', updated_ms = ${now} WHERE operation_id = ${op.id} AND generation = ${generation} AND state = 'active' RETURNING operation_id`;
    yield sql`INSERT INTO photo_derivative_operation_generations (operation_id, generation, owner, nonce, state, created_ms, updated_ms) VALUES (${op.id}, ${next}, ${owner}, ${nonce}, 'active', ${now}, ${now}) RETURNING operation_id`;
    return { kind: "owned", op: { id: op.id, generation: next, owner, nonce, key } };
  }
  const id = randomUUID(), owner = randomUUID(), nonce = randomUUID();
  yield sql`INSERT INTO photo_derivative_operations (id, kind, derivative_key, source_key, source_fingerprint, recipe, generation, owner, nonce, state, lease_until_ms, created_ms, updated_ms)
    VALUES (${id}, 'instagram_derivative', ${key}, ${sourceKey}, ${fingerprint}, ${recipe}, 1, ${owner}, ${nonce}, 'preparing', ${now} + ${ttl}, ${now}, ${now}) RETURNING id`;
  yield sql`INSERT INTO photo_derivative_operation_generations (operation_id, generation, owner, nonce, state, created_ms, updated_ms) VALUES (${id}, 1, ${owner}, ${nonce}, 'active', ${now}, ${now}) RETURNING operation_id`;
  return { kind: "owned", op: { id, generation: 1, owner, nonce, key } };
}

function* sealSteps(driver: OwnershipDriver, op: Owned, proof: Awaited<ReturnType<typeof fileProof>>): Generator<SQL, boolean, Rows> {
  const now = nowMs(driver);
  const rows = yield sql`UPDATE photo_derivative_operations SET state = 'sealed', seal_sha256 = ${proof.sha256}, seal_bytes = ${proof.bytes}, seal_dev = ${proof.dev}, seal_ino = ${proof.ino}, updated_ms = ${now}
    WHERE id = ${op.id} AND generation = ${op.generation} AND owner = ${op.owner} AND nonce = ${op.nonce} AND state = 'preparing' AND lease_until_ms > ${now} RETURNING id`;
  return rows.length === 1;
}
function* commitSteps(driver: OwnershipDriver, op: Owned, sealSha256: string): Generator<SQL, boolean, Rows> {
  const now = nowMs(driver);
  const rows = yield sql`UPDATE photo_derivative_operations SET state = 'committed', updated_ms = ${now}
    WHERE id = ${op.id} AND generation = ${op.generation} AND owner = ${op.owner} AND nonce = ${op.nonce} AND state = 'sealed' AND seal_sha256 = ${sealSha256} AND lease_until_ms > ${now} RETURNING id`;
  if (rows.length !== 1) return false;
  const history = yield sql`UPDATE photo_derivative_operation_generations SET state = 'committed', updated_ms = ${now} WHERE operation_id = ${op.id} AND generation = ${op.generation} AND owner = ${op.owner} AND nonce = ${op.nonce} AND state = 'active' RETURNING operation_id`;
  if (history.length !== 1) throw new W11OperationRefusedError("W11_OPERATION_FENCE_LOST"); // rolls the commit back
  return true;
}
function* reviewSteps(driver: OwnershipDriver, op: Owned, reason: string): Generator<SQL, void, Rows> {
  yield sql`UPDATE photo_derivative_operations SET state = 'review', review_reason = ${reason}, updated_ms = ${nowMs(driver)} WHERE id = ${op.id} AND generation = ${op.generation} AND nonce = ${op.nonce} AND state IN ('preparing', 'sealed') RETURNING id`;
}

/** Proposed fenced W11 preparation; returns the canonical derivative key. `source` is the validated canonical WebP. */
export async function prepareFencedInstagramDerivative(
  db: DbClient,
  input: { sourceKey: string; source: Buffer; recipeId: InstagramImageRecipe },
  options: { driver?: OwnershipDriver; canonicalRoot?: string; leaseMs?: number; hooks?: W11Hooks } = {},
): Promise<string> {
  const driver = options.driver ?? ownershipDriver();
  const canonicalRoot = options.canonicalRoot ?? productPhotoStaticRoot;
  const fingerprint = sourceFingerprint(input.sourceKey, input.source);
  const key = `${input.recipeId}-${fingerprint}.jpg`;
  const ttl = options.leaseMs ?? W11_LEASE_MS;
  const destination = path.join(canonicalRoot, key);

  let claim: Claim;
  try { claim = await inOwnershipTransaction(db, driver, () => claimSteps(driver, key, input.sourceKey, fingerprint, input.recipeId, ttl)); }
  catch (error) {
    if (!uniqueViolation(error)) throw error;
    claim = await inOwnershipTransaction(db, driver, () => claimSteps(driver, key, input.sourceKey, fingerprint, input.recipeId, ttl));
  }
  if (claim.kind === "committed") {
    // Committed derivatives are served only if the canonical bytes still equal the seal.
    if ((await fileProof(destination)).sha256 !== claim.sealSha256) throw new W11OperationRefusedError("W11_OPERATION_REVIEW");
    return key;
  }
  if (claim.kind === "conflict") throw new W11OperationRefusedError("W11_OPERATION_CONFLICT");
  if (claim.kind === "in-progress") throw new W11OperationRefusedError("W11_OPERATION_IN_PROGRESS");
  if (claim.kind !== "owned") throw new W11OperationRefusedError("W11_OPERATION_REVIEW");
  const op = claim.op;

  const operationDir = path.join(photoOperationPrivateRoot(canonicalRoot), "derivatives", op.id);
  await mkdir(operationDir, { recursive: true, mode: 0o700 });
  const generationDir = path.join(operationDir, String(op.generation));
  await mkdir(generationDir, { mode: 0o700 }); // exclusive: never reuse a generation directory
  const privateFile = path.join(generationDir, "derivative.jpg");
  await writeFile(privateFile, await renderInstagramDerivative(input.source, input.recipeId), { flag: "wx", mode: 0o600 });

  const seal = await fileProof(privateFile);
  if (!(await inOwnershipTransaction(db, driver, () => sealSteps(driver, op, seal)))) throw new W11OperationRefusedError("W11_OPERATION_FENCE_LOST");
  await options.hooks?.afterSeal?.();

  const current = await fileProof(privateFile);
  if (current.sha256 !== seal.sha256 || current.ino !== seal.ino || current.dev !== seal.dev) {
    await inOwnershipTransaction(db, driver, () => reviewSteps(driver, op, "sealed derivative changed before publication"));
    throw new W11OperationRefusedError("W11_OPERATION_REVIEW");
  }
  await mkdir(canonicalRoot, { recursive: true });
  let linked = false;
  try { await link(privateFile, destination); linked = true; }
  catch (error: any) { if (error?.code !== "EEXIST") throw error; }
  const published = await fileProof(destination);
  if (published.sha256 !== seal.sha256 || (linked && (published.ino !== seal.ino || published.dev !== seal.dev))) {
    await inOwnershipTransaction(db, driver, () => reviewSteps(driver, op, linked ? "published inode differs from the seal" : "derivative key exists with different bytes"));
    throw new W11OperationRefusedError("W11_OPERATION_REVIEW");
  }
  await options.hooks?.afterPublish?.();

  if (!(await inOwnershipTransaction(db, driver, () => commitSteps(driver, op, seal.sha256)))) throw new W11OperationRefusedError("W11_OPERATION_FENCE_LOST");
  await unlink(privateFile).catch(() => undefined); // the canonical name now owns the inode
  await options.hooks?.afterCommit?.();
  return key;
}
