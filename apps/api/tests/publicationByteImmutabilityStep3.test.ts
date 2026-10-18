/**
 * #472 F2 Step 3 OFFLINE byte-immutability proof (single host, unprivileged Linux, test-only).
 * A copy-owned publisher stages sealed worker bytes into its OWN inode, verifies the copy, records it and links it.
 * Workers run CONFINED by the Step 2 launcher. Snapshot integrity (copy == seal) and post-publication byte
 * immutability (no worker write path to the published inode) are asserted separately. The 470 LIMIT test stays the
 * external negative control; N1/N2 below are in-suite sensitivity controls. Runtime Photo F2 stays HIGH/FAIL.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { fork, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { publish, publishByLinkingWorkerInode, sealSource, stagingDir, type Outcome, type Phase, type PublishTarget } from "./f2s3/snapshotPublisher";

const launcher = process.env.F2_CAPABILITY_LAUNCHER;
const native = process.platform === "linux" && !!launcher;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "noctella-f2s3-"));
const workerFixture = path.join(__dirname, "fixtures", "f2s3Worker.cjs");
const publisherFixture = path.join(__dirname, "fixtures", "f2s3Publisher.ts");
const DENIED = ["EACCES", "EPERM", "EXDEV"];
const SIZE = 256 * 1024, CHUNK = 64 * 1024;
const content = Array.from({ length: SIZE }, (_, i) => String.fromCharCode(65 + (i % 26))).join("");

it.runIf(process.env.F2_CAPABILITY_REQUIRE_LINUX === "1")("required unprivileged Linux byte-immutability proof is configured", () => {
  expect(process.platform).toBe("linux"); expect(launcher).toBeTruthy(); expect(process.getuid?.()).not.toBe(0);
});

const children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) { c.kill("SIGKILL"); await new Promise((r) => c.once("exit", r)); }
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));

async function bounded<T>(p: Promise<T>, label: string, ms = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([p, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("BLOCKED: " + label)), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const ident = (file: string) => { const st = fs.statSync(file, { bigint: true }); return { dev: String(st.dev), ino: String(st.ino), nlink: Number(st.nlink) }; };

function layout() {
  const base = fs.mkdtempSync(path.join(root, "case-"));
  const dirs = { priv: path.join(base, "private"), canonicalDir: path.join(base, "canonical"), stagingRoot: path.join(base, "staging") };
  for (const d of Object.values(dirs)) fs.mkdirSync(d);
  return { ...dirs, source: path.join(dirs.priv, "source.webp"), alias: path.join(dirs.priv, "alias.webp"), canonical: path.join(dirs.canonicalDir, "photo.webp") };
}
const target = (l: ReturnType<typeof layout>, seal: PublishTarget["seal"]): PublishTarget =>
  ({ source: l.source, seal, canonicalDir: l.canonicalDir, canonicalName: "photo.webp", stagingRoot: l.stagingRoot, operationId: "op-1", generation: 1, chunkSize: CHUNK });

/** Confined worker (Step 2 launcher, trusted layout with Node IPC on fd 3); `confined=false` only for control N2. */
async function worker(allowed: string, confined = true) {
  const proc = confined
    ? spawn(launcher!, [allowed, "--", process.execPath, workerFixture], { stdio: ["ignore", "pipe", "pipe", "ipc"] })
    : spawn(process.execPath, [workerFixture], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  children.push(proc);
  let err = ""; proc.stderr?.on("data", (d) => { err += d; });
  const pending = new Map<number, (v: any) => void>(); let next = 0;
  await bounded(new Promise<void>((resolve, reject) => {
    proc.on("message", (m: any) => { if (m?.ready) resolve(); else if (m?.id && pending.has(m.id)) { pending.get(m.id)!(m.result); pending.delete(m.id); } });
    proc.once("exit", () => reject(new Error("worker exited: " + err)));
  }), "worker ready");
  if (confined) expect(err).toContain("LANDLOCK_ENFORCED");
  return {
    proc,
    do: (cmd: string, args: Record<string, unknown> = {}) => bounded(new Promise<any>((resolve) => { const id = ++next; pending.set(id, resolve); proc.send({ id, cmd, args }); }), cmd),
  };
}

/** Trusted publisher process with deterministic phase barriers. */
async function publisher(t: PublishTarget, barriers: Phase[] = []) {
  const proc = fork(publisherFixture, [], { execArgv: ["--import", "tsx"], cwd: path.resolve(__dirname, ".."), stdio: ["ignore", "pipe", "pipe", "ipc"] });
  children.push(proc);
  const queue: any[] = []; const waiters: Array<(m: any) => void> = [];
  proc.on("message", (m) => { const w = waiters.shift(); if (w) w(m); else queue.push(m); });
  const exited = new Promise<{ code: number | null; signal: string | null }>((r) => proc.once("exit", (code, signal) => r({ code, signal })));
  const nextMessage = () => bounded(new Promise<any>((resolve) => { const m = queue.shift(); if (m) resolve(m); else waiters.push(resolve); }), "publisher message");
  expect((await nextMessage()).ready).toBeTruthy();
  proc.send({ target: t, barriers });
  return {
    proc, exited,
    at: async (phase: Phase) => { const m = await nextMessage(); expect(m.at).toBe(phase); return m.detail; },
    go: () => proc.send("go"),
    outcome: async (): Promise<Outcome> => { const m = await nextMessage(); if (m.error) throw new Error(m.error); return m.outcome; },
    kill: async () => { proc.kill("SIGKILL"); return bounded(exited, "publisher exit"); },
  };
}

/** Worker creates its own source, keeps a retained r/w descriptor and a private hardlink alias; then the seal. */
async function prepared(l: ReturnType<typeof layout>) {
  const w = await worker(l.priv);
  expect(await w.do("write-file", { path: l.source, content })).toBe("OK");
  expect(typeof (await w.do("retain", { path: l.source }))).toBe("number");
  expect(await w.do("link", { from: l.source, to: l.alias })).toBe("OK");
  return { w, seal: sealSource(l.source) }; // worker idle: it acts only on explicit commands
}
const stagingNames = (t: PublishTarget) => { try { return fs.readdirSync(stagingDir(t)).sort(); } catch { return []; } };

describe.skipIf(!native)("controls: the harness detects mutation; confinement is the enforced boundary", () => {
  it("N1: linking the worker's own inode (rejected design) lets a confined worker mutate canonical bytes", async () => {
    const l = layout(); const { w, seal } = await prepared(l);
    publishByLinkingWorkerInode(target(l, seal));
    expect(await w.do("write-at", { path: l.alias, offset: 0, content: "ALIAS" })).toBe("OK");
    expect(sha(l.canonical)).not.toBe(seal.sha256); // LIMIT shape reproduced in-suite: detection works
  });
  it("N2: an UNCONFINED same-UID process can still write the copy-owned published file, even after chmod 0444", async () => {
    const l = layout(); const { seal } = await prepared(l);
    expect((await publish(target(l, seal))).kind).toBe("PUBLISHED");
    fs.chmodSync(l.canonical, 0o444);
    const outside = await worker(l.priv, false);
    expect(await outside.do("chmod", { path: l.canonical, mode: 0o644 })).toBe("OK");
    expect(await outside.do("write-at", { path: l.canonical, offset: 0, content: "OWNER" })).toBe("OK");
    expect(sha(l.canonical)).not.toBe(seal.sha256); // copy + chmod alone are NOT immutability
  });
});

describe.skipIf(!native)("post-publication byte immutability against a confined worker", () => {
  it("PI: no confined-worker path reaches the published inode; source-side writes cannot alter published bytes", async () => {
    const l = layout(); const { w, seal } = await prepared(l);
    const t = target(l, seal);
    const out = await publish(t);
    expect(out.kind).toBe("PUBLISHED");
    const pub = ident(l.canonical), src = ident(l.source);
    expect([pub.dev, pub.ino]).not.toEqual([src.dev, src.ino]); // publisher-owned inode, independent of the source
    expect(stagingNames(t)).toEqual(["manifest.json"]);
    // Retained authority over the SOURCE still works — and reaches only the source.
    expect(await w.do("write-retained", { offset: 0, content: "RETAINED" })).toBe("OK");
    expect(await w.do("write-at", { path: l.alias, offset: 8, content: "ALIAS" })).toBe("OK");
    expect(await w.do("replace", { path: l.source, content: "REPLACED" })).toBe("OK");
    // Every path to the published inode is denied.
    const attempts: Record<string, unknown> = {
      linkAlias: await w.do("link", { from: l.canonical, to: path.join(l.priv, "stolen.webp") }),
      openRw: await w.do("open", { path: l.canonical, flags: "r+" }),
      openTrunc: await w.do("open", { path: l.canonical, flags: "w" }),
      openAppend: await w.do("open", { path: l.canonical, flags: "a" }),
      truncate: await w.do("truncate", { path: l.canonical }),
      renameOver: await w.do("rename", { from: l.alias, to: l.canonical }),
      unlink: await w.do("unlink", { path: l.canonical }),
    };
    for (const [name, code] of Object.entries(attempts)) expect(DENIED, name).toContain(code);
    // Metadata is NOT protected by Landlock ABI 3 (documented limit) — but it grants no byte write.
    expect(await w.do("chmod", { path: l.canonical, mode: 0o666 })).toBe("OK");
    expect(DENIED).toContain(await w.do("open", { path: l.canonical, flags: "r+" }));
    expect(await w.do("probe", { dev: pub.dev, ino: pub.ino })).toBe("FD_ABSENT");
    expect(sha(l.canonical)).toBe(seal.sha256);
    if (out.kind !== "PUBLISHED") throw new Error("unreachable");
    // Same recorded inode, and nlink 1: no other name (no hardlink alias) for the published inode exists anywhere.
    expect(ident(l.canonical)).toEqual({ dev: out.dev, ino: out.ino, nlink: 1 });
  });
  it("PF: the publisher's own retained staging write descriptor is unreachable from a confined worker", async () => {
    const l = layout(); const { w, seal } = await prepared(l);
    const p = await publisher(target(l, seal), ["copied"]);
    const detail = await p.at("copied");
    expect(DENIED).toContain(await w.do("proc-fd-write", { pid: detail.pid, fd: detail.fd }));
    p.go();
    expect((await p.outcome()).kind).toBe("PUBLISHED");
    expect(sha(l.canonical)).toBe(seal.sha256);
  });
});

describe.skipIf(!native)("source snapshot integrity (copy must equal the seal and the sealed inode)", () => {
  const withBarrier = async (phase: Phase, action: (w: Awaited<ReturnType<typeof worker>>, l: ReturnType<typeof layout>) => Promise<void>) => {
    const l = layout(); const { w, seal } = await prepared(l);
    const t = target(l, seal);
    const p = await publisher(t, [phase]);
    await p.at(phase); await action(w, l); p.go(); // worker acts strictly between the barrier and its release
    return { l, t, seal, outcome: await p.outcome() };
  };
  it("SI1: mutation after the seal, before copying, is rejected", async () => {
    const r = await withBarrier("source-opened", async (w) => { expect(await w.do("write-retained", { offset: 0, content: "EARLY" })).toBe("OK"); });
    expect(r.outcome.kind).toBe("SNAPSHOT_MISMATCH");
    expect(fs.existsSync(r.l.canonical)).toBe(false); expect(stagingNames(r.t)).toEqual([]);
  });
  it("SI2a: concurrent mutation of a not-yet-copied region is rejected", async () => {
    const r = await withBarrier("copy-partial", async (w) => { expect(await w.do("write-retained", { offset: SIZE - 100, content: "LATE" })).toBe("OK"); });
    expect(r.outcome.kind).toBe("SNAPSHOT_MISMATCH");
    expect(fs.existsSync(r.l.canonical)).toBe(false); expect(stagingNames(r.t)).toEqual([]);
  });
  it("SI2b: mutation of an already-copied region cannot reach the copy; published bytes equal the seal", async () => {
    const r = await withBarrier("copy-partial", async (w) => { expect(await w.do("write-retained", { offset: 0, content: "COPIED" })).toBe("OK"); });
    expect(r.outcome.kind).toBe("PUBLISHED");
    expect(sha(r.l.canonical)).toBe(r.seal.sha256); expect(sha(r.l.source)).not.toBe(r.seal.sha256);
  });
  it("SI4: truncation of the source during copying is rejected", async () => {
    const r = await withBarrier("copy-partial", async (w) => { expect(await w.do("truncate-retained", { size: 1000 })).toBe("OK"); });
    expect(r.outcome.kind).toBe("SNAPSHOT_MISMATCH"); expect(fs.existsSync(r.l.canonical)).toBe(false);
  });
  it("SI5: mutation after verification cannot alter what is published", async () => {
    const r = await withBarrier("verified", async (w) => { expect(await w.do("write-retained", { offset: 0, content: "AFTER" })).toBe("OK"); });
    expect(r.outcome.kind).toBe("PUBLISHED"); expect(sha(r.l.canonical)).toBe(r.seal.sha256);
  });
  it.each([["different", "OTHER"], ["identical", content]])("SI3: source replacement with %s bytes is rejected by inode provenance", async (_label, replacement) => {
    const l = layout(); const { w, seal } = await prepared(l);
    expect(await w.do("replace", { path: l.source, content: replacement })).toBe("OK");
    expect((await publish(target(l, seal))).kind).toBe("SOURCE_REPLACED");
    expect(fs.existsSync(l.canonical)).toBe(false);
  });
});

describe.skipIf(!native)("crash boundaries, retry, collisions and cleanup ownership", () => {
  it.each(["staging-created", "copy-partial", "copied", "verified", "manifest-written", "linked"] as Phase[])("CR: SIGKILL at %s never exposes partial bytes; retry converges to the sealed bytes", async (phase) => {
    const l = layout(); const { seal } = await prepared(l);
    const t = target(l, seal);
    const p = await publisher(t, [phase]);
    await p.at(phase);
    expect((await p.kill()).signal).toBe("SIGKILL");
    if (phase !== "linked") expect(fs.existsSync(l.canonical)).toBe(false); // nothing partial was ever linked
    const linkedInode = phase === "linked" ? ident(l.canonical) : null;
    const retry = await publish(t);
    expect(retry.kind).toBe(phase === "linked" ? "ADOPTED" : "PUBLISHED");
    if (linkedInode) expect(ident(l.canonical).ino).toBe(linkedInode.ino);
    expect(sha(l.canonical)).toBe(seal.sha256);
    expect(ident(l.canonical).nlink).toBe(1);
    expect(stagingNames(t)).toEqual(["manifest.json"]); // own leftovers removed; nothing else touched
    expect(fs.existsSync(l.source) && fs.existsSync(l.alias)).toBe(true); // worker-owned names are never cleaned by the publisher
  });
  it("ID: a repeated publication is idempotent and keeps the recorded inode", async () => {
    const l = layout(); const { seal } = await prepared(l);
    const t = target(l, seal);
    const first = await publish(t); const second = await publish(t);
    expect([first.kind, second.kind]).toEqual(["PUBLISHED", "ADOPTED"]);
    expect(second.kind === "ADOPTED" && first.kind === "PUBLISHED" && second.ino === first.ino).toBe(true);
  });
  it.each([["different", "FOREIGN"], ["identical", content]])("CL: a pre-existing foreign canonical file with %s bytes is a collision and is never touched", async (_label, foreign) => {
    const l = layout(); const { seal } = await prepared(l);
    fs.writeFileSync(l.canonical, foreign); const before = ident(l.canonical), bytes = sha(l.canonical);
    const t = target(l, seal);
    expect((await publish(t)).kind).toBe("COLLISION");
    expect([ident(l.canonical).ino, sha(l.canonical)]).toEqual([before.ino, bytes]);
    expect(stagingNames(t).filter((n) => n.startsWith("data-"))).toEqual([]);
  });
  it("CL2: a foreign file appearing between manifest and link is a collision; the foreign file and source are untouched", async () => {
    const l = layout(); const { seal } = await prepared(l);
    const t = target(l, seal);
    const p = await publisher(t, ["manifest-written"]);
    await p.at("manifest-written");
    fs.writeFileSync(l.canonical, "RACE"); const before = ident(l.canonical);
    p.go();
    expect((await p.outcome()).kind).toBe("COLLISION");
    expect([ident(l.canonical).ino, fs.readFileSync(l.canonical, "utf8")]).toEqual([before.ino, "RACE"]);
    expect(stagingNames(t).filter((n) => n.startsWith("data-"))).toEqual([]);
    expect(sha(l.source)).toBe(seal.sha256);
  });
});
