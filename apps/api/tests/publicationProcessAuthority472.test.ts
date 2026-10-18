/**
 * #472 F2 Step 2 OFFLINE process-authority proof (single host, unprivileged Linux, test launcher only).
 * Descriptor controls/refusals at every reserved fd, Landlock inheritance by descendants, supervisor completion bound
 * to a private report channel, deterministic fault points and test-owned cleanup through a pidfd-sweeping reaper.
 * Proves nothing about production revocation, cross-host writers, spawn services or byte immutability (Step 3).
 * Runtime Photo F2 stays HIGH/FAIL. The Contract 1 cooperative proof is separate and is not evidenced here.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { spawn, execFileSync, type ChildProcess, type StdioOptions } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const launcher = process.env.F2_CAPABILITY_LAUNCHER;
const native = process.platform === "linux" && !!launcher;
const fixture = path.join(__dirname, "fixtures", "processAuthority472.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "noctella-pa-472-"));
const node = process.execPath;

it.runIf(process.env.F2_CAPABILITY_REQUIRE_LINUX === "1")("required unprivileged Linux process-authority proof is configured", () => {
  expect(process.platform).toBe("linux"); expect(launcher).toBeTruthy(); expect(process.getuid?.()).not.toBe(0);
  expect(fs.statSync(launcher!).isFile()).toBe(true);
});

interface Run { proc: ChildProcess; out: string[]; err: () => string; reports: Map<number, { lines: string[]; ended: boolean }>; exit: Promise<{ code: number | null; signal: string | null }> }
const owned: Run[] = [];
const reapers: Run[] = [];

function lines(target: string[]) { let rest = ""; return (d: Buffer) => { rest += d; const parts = rest.split("\n"); rest = parts.pop()!; target.push(...parts); }; }
function run(cmd: string, args: string[], stdio: StdioOptions, env: NodeJS.ProcessEnv = {}, reportFds: number[] = []): Run {
  const proc = spawn(cmd, args, { stdio, env: { ...process.env, ...env } });
  const out: string[] = []; let err = "";
  proc.stdout?.on("data", lines(out)); proc.stderr?.on("data", (d) => { err += d; });
  const reports = new Map<number, { lines: string[]; ended: boolean }>();
  for (const fd of reportFds) {
    const entry = { lines: [] as string[], ended: false };
    const stream = proc.stdio[fd] as NodeJS.ReadableStream;
    stream.on("data", lines(entry.lines)); stream.on("end", () => { entry.ended = true; });
    reports.set(fd, entry);
  }
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => proc.once("exit", (code, signal) => resolve({ code, signal })));
  const r = { proc, out, err: () => err, reports, exit };
  owned.push(r);
  return r;
}
async function bounded<T>(promise: Promise<T>, label: string, ms = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("BLOCKED: " + label)), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
/** Event wait; the deadline is only a failure bound, never a passing condition. */
const waitFor = (check: () => boolean, label: string, ms = 15_000) => bounded(new Promise<void>((resolve) => {
  const tick = () => { if (check()) resolve(); else setTimeout(tick, 20); }; tick();
}), label, ms);

function tempFile(name: string, content = "ORIGINAL") { const file = path.join(root, `${name}-${Math.random().toString(16).slice(2)}`); fs.writeFileSync(file, content); return file; }
function dirs() {
  const base = fs.mkdtempSync(path.join(root, "case-"));
  const allowed = path.join(base, "private"), canonical = path.join(base, "canonical");
  fs.mkdirSync(allowed); fs.mkdirSync(canonical);
  const src = path.join(allowed, "source.webp"); fs.writeFileSync(src, "sealed");
  return { allowed, canonical, src };
}
/** Only `--supervise` completion records bound to the reaper-observed exit of that exact supervisor are accepted. */
function gate(supervisor: { lines: string[]; ended: boolean } | undefined, reaper: { lines: string[] }): "COMPLETE" | "BLOCKED" {
  if (!supervisor || !supervisor.ended) return "BLOCKED";
  const records = supervisor.lines.filter(Boolean);
  const done = records.length === 1 ? /^F2PA1 COMPLETE supervisor=(\d+) worker_status=(-?\d+)$/.exec(records[0]) : null;
  const inner = reaper.lines.map((l) => /^F2PA1 INNER_EXIT pid=(\d+) code=(\d+)$/.exec(l)).find(Boolean);
  return done && inner && inner[1] === done[1] && inner[2] === "0" ? "COMPLETE" : "BLOCKED";
}
async function stopReaper(r: Run) {
  r.proc.kill("SIGTERM"); // R is this process's own direct, unreaped child; no unknown PID is ever signalled
  const result = await bounded(r.exit, "reaper cleanup", 15_000);
  expect(result.code).toBe(0);
  expect(r.reports.get(5)!.lines).toContain("F2PA1 REAPER_COMPLETE");
}
/** R --reaper (report fd 5) -> inner launcher command. Index 4 carries an inner supervisor's private report channel. */
function underReaper(inner: string[], env: NodeJS.ProcessEnv = {}, ipc = false): Run {
  const r = run(launcher!, ["--reaper", "--report-fd=5", "--", ...inner], ["ignore", "pipe", "pipe", ipc ? "ipc" : "ignore", "pipe", "pipe"], env, [4, 5]);
  reapers.push(r);
  return r;
}

afterEach(async () => {
  for (const r of reapers.splice(0)) if (r.proc.exitCode === null && r.proc.signalCode === null) await stopReaper(r);
  for (const r of owned.splice(0)) if (r.proc.exitCode === null && r.proc.signalCode === null) { r.proc.kill("SIGKILL"); await bounded(r.exit, "owned exit", 5000); }
});
afterAll(() => { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });

const slot = (k: number, fd: number): StdioOptions => {
  const s: any[] = ["ignore", "pipe", "pipe"];
  if (k < 3) s[k] = fd; else if (k === 3) s[3] = fd; else { s[3] = "ignore"; s[4] = fd; }
  return s;
};

describe.skipIf(!native)("descriptor controls and launcher refusals", () => {
  it.each([0, 1, 2, 3, 4])("C0-%i control: a regular file at fd %i is a write capability without the launcher", async (k) => {
    const x = tempFile("ctl"), fd = fs.openSync(x, "r+");
    const r = run(node, [fixture, "write-fd", String(k), "MARK"], slot(k, fd)); fs.closeSync(fd);
    expect((await bounded(r.exit, "control")).code).toBe(0);
    expect(fs.readFileSync(x, "utf8")).toContain("MARK");
  });
  it.each([0, 1, 2, 3])("D%i: the launcher refuses a regular file at reserved fd %i before exec", async (k) => {
    const { allowed } = dirs(); const x = tempFile("ref"), fd = fs.openSync(x, "r+");
    const r = run(launcher!, [allowed, "--", node, fixture, "write-fd", String(k), "MARK"], slot(k, fd)); fs.closeSync(fd);
    expect((await bounded(r.exit, "refusal")).code).toBe(125);
    expect(fs.readFileSync(x, "utf8")).toBe("ORIGINAL");
    if (k !== 2) { expect(r.err()).toContain(`LAUNCHER_REFUSED fd${k}`); expect(r.err()).not.toContain("LANDLOCK_ENFORCED"); }
  });
  it("D4: an inherited fd >= 4 is closed before exec (EBADF), distinct from Landlock path policy", async () => {
    const { allowed } = dirs(); const x = tempFile("fd4"), fd = fs.openSync(x, "r+");
    const r = run(launcher!, [allowed, "--", node, fixture, "write-fd", "4", "MARK"], slot(4, fd)); fs.closeSync(fd);
    expect((await bounded(r.exit, "fd4")).code).toBe(3);
    expect(r.err()).toContain("LANDLOCK_ENFORCED");
    expect(fs.readFileSync(x, "utf8")).toBe("ORIGINAL");
  });
  it("D5a: a named FIFO as stdout is refused", async () => {
    const { allowed } = dirs(); const fifo = path.join(root, "fifo-" + Date.now());
    execFileSync("mkfifo", [fifo]); const fd = fs.openSync(fifo, "r+");
    const r = run(launcher!, [allowed, "--", node, fixture, "write-fd", "9", "x"], ["ignore", fd, "pipe"]); fs.closeSync(fd);
    expect((await bounded(r.exit, "fifo")).code).toBe(125);
    expect(r.err()).toContain("LAUNCHER_REFUSED fd1-untrusted-endpoint");
  });
  it("D5b: an fd 3 socket whose peer is not the trusted spawner is refused", async () => {
    const { allowed } = dirs(); const sock = path.join(root, "peer-" + Date.now() + ".sock");
    const helper = run(node, ["-e", `require('net').createServer(()=>{}).listen(${JSON.stringify(sock)},()=>console.log('L'))`], ["ignore", "pipe", "pipe"]);
    await waitFor(() => helper.out.includes("L"), "helper listen");
    const client = net.createConnection(sock); await new Promise((r) => client.once("connect", r));
    const r = run(launcher!, [allowed, "--", node, fixture, "write-fd", "9", "x"], ["ignore", "pipe", "pipe", client]);
    expect((await bounded(r.exit, "foreign peer")).code).toBe(125);
    expect(r.err()).toContain("LAUNCHER_REFUSED fd3-untrusted-endpoint");
    client.destroy();
  });
  it("D5c: an absent fd 2 is refused (silently) and the worker never runs", async () => {
    const { allowed } = dirs();
    const r = run("/bin/sh", ["-c", 'exec 2>&- "$@"', "sh", launcher!, allowed, "--", node, fixture, "write-fd", "9", "x"], ["ignore", "pipe", "pipe"]);
    expect((await bounded(r.exit, "absent fd2")).code).toBe(125);
  });
  it("D5d: a forged trusted-spawner environment is checked against the actual peer, not trusted", async () => {
    const { allowed } = dirs();
    const r = run(launcher!, [allowed, "--", node, fixture, "write-fd", "9", "x"], ["ignore", "pipe", "pipe"], { F2_TRUSTED_SPAWNER_PID: "1" });
    expect((await bounded(r.exit, "forged spawner")).code).toBe(125);
  });
  it("D6: under the trusted layout, Landlock denies opening or linking into the canonical directory", async () => {
    const { allowed, canonical, src } = dirs(); const x = path.join(canonical, "existing.webp"); fs.writeFileSync(x, "ORIGINAL");
    const open = run(launcher!, [allowed, "--", node, fixture, "open-write", x], ["ignore", "pipe", "pipe"]);
    await bounded(open.exit, "open"); expect(["OPEN EACCES", "OPEN EPERM"]).toContain(open.out[0]);
    const link = run(launcher!, [allowed, "--", node, fixture, "link", src, path.join(canonical, "new.webp")], ["ignore", "pipe", "pipe"]);
    await bounded(link.exit, "link"); expect(["LINK EACCES", "LINK EPERM", "LINK EXDEV"]).toContain(link.out[0]);
    expect(fs.readFileSync(x, "utf8")).toBe("ORIGINAL"); expect(fs.existsSync(path.join(canonical, "new.webp"))).toBe(false);
  });
  it("D7a: the trusted direct layout including Node IPC is accepted", async () => {
    const { allowed } = dirs();
    const r = run(launcher!, [allowed, "--", node, fixture, "write-fd", "9", "x"], ["ignore", "pipe", "pipe", "ipc"]);
    expect((await bounded(r.exit, "direct ipc")).code).toBe(3); expect(r.err()).toContain("LANDLOCK_ENFORCED");
  });
  it("D7b: the trusted layout including Node IPC is accepted through the reaper wrapper", async () => {
    const { allowed } = dirs();
    const r = underReaper([launcher!, allowed, "--", node, fixture, "write-fd", "9", "x"], {}, true);
    await waitFor(() => r.reports.get(5)!.lines.some((l) => l.startsWith("F2PA1 INNER_EXIT")), "inner exit");
    expect(r.reports.get(5)!.lines).toContainEqual(expect.stringMatching(/^F2PA1 INNER_EXIT pid=\d+ code=3$/));
    expect(r.err()).toContain("LANDLOCK_ENFORCED");
    await stopReaper(r); reapers.splice(reapers.indexOf(r), 1);
  });
});

describe.skipIf(!native)("descendants, completion authenticity and transfer safety", () => {
  const denied = (out: string[], kind: string, label: string) => {
    const line = out.find((l) => l.startsWith(`${kind} ${label} `));
    expect(["EACCES", "EPERM", "EXDEV"]).toContain(line?.split(" ")[2]);
  };
  const heartbeatAfter = async (r: Run, label: string) => {
    const seen = r.out.filter((l) => l.startsWith(`HB ${label} `)).length;
    await waitFor(() => r.out.filter((l) => l.startsWith(`HB ${label} `)).length > seen, `${label} heartbeat`);
  };

  it("T1: --supervise revokes a setsid grandchild and a double-fork orphan; completion is bound to the supervisor exit", async () => {
    const { allowed, canonical, src } = dirs();
    const r = underReaper([launcher!, "--supervise", "--report-fd=4", allowed, "--", node, fixture, "tree", canonical, src, "exit"]);
    await waitFor(() => r.reports.get(4)!.ended && r.reports.get(5)!.lines.some((l) => l.startsWith("F2PA1 INNER_EXIT")), "supervisor completion");
    expect(r.out.some((l) => l.startsWith("TREE_READY"))).toBe(true);
    for (const label of ["setsid", "orphan"]) { denied(r.out, "LINK", label); denied(r.out, "CREATE", label); }
    expect(gate(r.reports.get(4), r.reports.get(5)!)).toBe("COMPLETE");
    expect(fs.readdirSync(canonical)).toEqual([]);
    await stopReaper(r); reapers.splice(reapers.indexOf(r), 1);
  });

  it("T2/P2/P3: a direct child's exit is not revocation; confined survivors stay alive yet denied -> BLOCKED", async () => {
    const { allowed, canonical, src } = dirs();
    const r = underReaper([launcher!, allowed, "--", node, fixture, "tree", canonical, src, "exit"]);
    await waitFor(() => r.reports.get(5)!.lines.some((l) => l.startsWith("F2PA1 INNER_EXIT")), "direct exit");
    await heartbeatAfter(r, "setsid"); await heartbeatAfter(r, "orphan"); // alive after the direct child's exit
    for (const label of ["setsid", "orphan"]) { denied(r.out, "LINK", label); denied(r.out, "CREATE", label); }
    expect(gate(undefined, r.reports.get(5)!)).toBe("BLOCKED");
    expect(fs.readdirSync(canonical)).toEqual([]);
  });

  it("T3: a hostile worker killing the supervisor yields no completion -> BLOCKED; the outer reaper still cleans up", async () => {
    const { allowed, canonical, src } = dirs();
    const r = underReaper([launcher!, "--supervise", "--report-fd=4", allowed, "--", node, fixture, "tree", canonical, src, "kill-supervisor"]);
    await waitFor(() => r.reports.get(4)!.ended && r.reports.get(5)!.lines.some((l) => l.startsWith("F2PA1 INNER_EXIT")), "supervisor death");
    expect(r.reports.get(5)!.lines).toContainEqual(expect.stringMatching(/^F2PA1 INNER_EXIT pid=\d+ signal=9$/));
    expect(r.reports.get(4)!.lines.filter(Boolean)).toEqual([]);
    expect(gate(r.reports.get(4), r.reports.get(5)!)).toBe("BLOCKED");
    await heartbeatAfter(r, "setsid");
  });

  it("T4: fault sweep-blocked fires AFTER the worker tree started, reports BLOCKED, and the reaper stays operational", async () => {
    const { allowed, canonical, src } = dirs();
    const r = underReaper([launcher!, "--supervise", "--report-fd=4", allowed, "--", node, fixture, "tree", canonical, src, "exit"], { F2_LAUNCHER_FAULT: "supervise:sweep-blocked" });
    await waitFor(() => r.reports.get(4)!.ended, "blocked report");
    const [record] = r.reports.get(4)!.lines.filter(Boolean);
    const candidates = Number(/candidates=(\d+)$/.exec(record)?.[1]);
    expect(record).toMatch(/^F2PA1 BLOCKED supervisor=\d+ reason=fault-sweep-blocked candidates=\d+$/);
    expect(candidates).toBeGreaterThan(0); // the supervisor itself observed live descendants at fault time
    expect(r.out.find((l) => l.startsWith("TREE_READY"))).toContain("fault_env=absent"); // fault never reaches workers
    await waitFor(() => r.reports.get(5)!.lines.some((l) => l.startsWith("F2PA1 INNER_EXIT")), "inner exit");
    expect(r.reports.get(5)!.lines).toContainEqual(expect.stringMatching(/^F2PA1 INNER_EXIT pid=\d+ code=124$/));
    expect(gate(r.reports.get(4), r.reports.get(5)!)).toBe("BLOCKED");
    await heartbeatAfter(r, "setsid");
  });

  it("S1: worker spoofing of completion on stdout/stderr, fd 4 or /proc/<supervisor>/fd is rejected", async () => {
    const { allowed, canonical, src } = dirs();
    const r = underReaper([launcher!, "--supervise", "--report-fd=4", allowed, "--", node, fixture, "tree", canonical, src, "spoof"], { F2_LAUNCHER_FAULT: "supervise:sweep-blocked" });
    await waitFor(() => r.reports.get(4)!.ended && r.out.some((l) => l.startsWith("SPOOF")), "spoof attempt");
    expect(r.out.some((l) => l.startsWith("F2PA1 COMPLETE"))).toBe(true); // forged text exists on the worker channel
    const spoof = r.out.find((l) => l.startsWith("SPOOF"))!;
    expect(spoof).toContain("fd4=EBADF");
    expect(["procfd=EACCES", "procfd=EPERM"]).toContain(spoof.split(" ")[2]);
    expect(r.reports.get(4)!.lines.filter(Boolean)).toEqual([expect.stringMatching(/^F2PA1 BLOCKED supervisor=\d+ reason=fault-sweep-blocked/)]);
    expect(gate(r.reports.get(4), r.reports.get(5)!)).toBe("BLOCKED");
  });

  it("FI: a supervisor setup fault is pre-fork, isolated to the supervisor; the reaper (same environment) completes", async () => {
    const { allowed, canonical, src } = dirs();
    const r = underReaper([launcher!, "--supervise", "--report-fd=4", allowed, "--", node, fixture, "tree", canonical, src, "exit"], { F2_LAUNCHER_FAULT: "supervise:subreaper-unavailable" });
    await waitFor(() => r.reports.get(4)!.ended && r.reports.get(5)!.lines.some((l) => l.startsWith("F2PA1 INNER_EXIT")), "setup fault");
    expect(r.reports.get(5)!.lines).toContainEqual(expect.stringMatching(/^F2PA1 INNER_EXIT pid=\d+ code=125$/));
    expect(r.reports.get(4)!.lines.filter(Boolean)).toEqual([]);
    expect(r.out.some((l) => l.startsWith("TREE_READY"))).toBe(false); // no worker ever started
    expect(r.err()).toContain("LAUNCHER_REFUSED subreaper-unavailable");
  });
});

describe.skipIf(!native)("deterministic fault points and real setup failures (fail closed)", () => {
  it.each(["landlock-unavailable", "close-range-unavailable"])("plain fault %s refuses before exec", async (name) => {
    const { allowed } = dirs();
    const r = run(launcher!, [allowed, "--", node, fixture, "write-fd", "9", "x"], ["ignore", "pipe", "pipe"], { F2_LAUNCHER_FAULT: "plain:" + name });
    expect((await bounded(r.exit, name)).code).toBe(125); // worker would have exited 3
    if (name === "landlock-unavailable") { expect(r.err()).toContain("LANDLOCK_ABI_3_REQUIRED got=-1"); expect(r.err()).not.toContain("LANDLOCK_ENFORCED"); }
    // close_range is the last step after confinement: confined, but the worker is never executed.
    else expect(r.err()).toContain("LAUNCHER_REFUSED close-range-unavailable");
  });
  it.each(["subreaper-unavailable", "pidfd-unavailable", "proc-unavailable", "close-range-unavailable", "landlock-unavailable"])("supervise fault %s refuses before any worker starts", async (name) => {
    const { allowed, canonical, src } = dirs();
    const r = run(launcher!, ["--supervise", "--report-fd=4", allowed, "--", node, fixture, "tree", canonical, src, "exit"], ["ignore", "pipe", "pipe", "ignore", "pipe"], { F2_LAUNCHER_FAULT: "supervise:" + name }, [4]);
    expect((await bounded(r.exit, name)).code).toBe(125);
    expect(r.err()).toContain("LAUNCHER_REFUSED " + name); // refused for THIS reason, not an unrelated one
    await waitFor(() => r.reports.get(4)!.ended, "report eof");
    expect(r.reports.get(4)!.lines.filter(Boolean)).toEqual([]);
    expect(r.out.some((l) => l.startsWith("TREE_READY"))).toBe(false);
  });
  it("a fault addressed to another role is ignored", async () => {
    const { allowed } = dirs();
    const r = run(launcher!, [allowed, "--", node, fixture, "write-fd", "9", "x"], ["ignore", "pipe", "pipe"], { F2_LAUNCHER_FAULT: "supervise:landlock-unavailable" });
    expect((await bounded(r.exit, "role isolation")).code).toBe(3); expect(r.err()).toContain("LANDLOCK_ENFORCED");
  });
  it.each([
    ["missing directory", (d: ReturnType<typeof dirs>) => [path.join(d.allowed, "missing"), "--", node, fixture, "write-fd", "9", "x"]],
    ["file instead of directory", (d: ReturnType<typeof dirs>) => [d.src, "--", node, fixture, "write-fd", "9", "x"]],
    ["symlinked directory", (d: ReturnType<typeof dirs>) => { const l = path.join(root, "link-" + Math.random().toString(16).slice(2)); fs.symlinkSync(d.allowed, l); return [l, "--", node, fixture, "write-fd", "9", "x"]; }],
    ["missing separator", (d: ReturnType<typeof dirs>) => [d.allowed, node, fixture]],
    ["missing command", (d: ReturnType<typeof dirs>) => [d.allowed, "--"]],
    ["nonexistent executable", (d: ReturnType<typeof dirs>) => [d.allowed, "--", path.join(root, "no-such-exe")]],
  ] as const)("real setup failure: %s exits 125 and never runs an unconfined worker", async (_label, argsFor) => {
    const r = run(launcher!, argsFor(dirs()), ["ignore", "pipe", "pipe"]);
    expect((await bounded(r.exit, "setup failure")).code).toBe(125);
  });
  it("supervise: an exec failure after fork is reported as SETUP_FAILED, never COMPLETE", async () => {
    const { allowed } = dirs();
    const r = run(launcher!, ["--supervise", "--report-fd=4", allowed, "--", path.join(root, "no-such-exe")], ["ignore", "pipe", "pipe", "ignore", "pipe"], {}, [4]);
    expect((await bounded(r.exit, "exec failure")).code).toBe(125);
    await waitFor(() => r.reports.get(4)!.ended, "report eof");
    expect(r.reports.get(4)!.lines.filter(Boolean)).toEqual([expect.stringMatching(/^F2PA1 SETUP_FAILED supervisor=\d+ errno=\d+$/)]);
  });
});
