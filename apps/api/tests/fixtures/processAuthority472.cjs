/*
 * #472 Step 2 OFFLINE fixture. Worker-side behaviours run (optionally) under the test launcher. Results go to stdout
 * lines or exit codes; nothing here is trusted as revocation evidence by the test.
 *   write-fd FD MARKER          write MARKER through an inherited fd: exit 0 written, 3 EBADF, 4 other error
 *   open-write PATH             try to open PATH for writing: prints OPEN <code|OK>
 *   link SRC DST                try link(): prints LINK <code|OK>
 *   tree DIR SRC BEHAVIOUR      spawn a detached setsid grandchild and a double-fork orphan, wait until both are ready,
 *                               then BEHAVIOUR: exit | kill-supervisor | spoof
 *   grand LABEL DIR SRC         heartbeat forever; attempt link + create in DIR once (internal)
 *   middle DIR SRC              spawn an orphan grandchild, relay its readiness, then exit (internal)
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const [mode, ...args] = process.argv.slice(2);
const code = (fn) => { try { fn(); return "OK"; } catch (error) { return error && error.code ? error.code : "ERR"; } };
const say = (line) => { try { fs.writeSync(1, line + "\n"); } catch { /* stdout may be gone after revocation */ } };

function child(childArgs, extra = {}) {
  // fd 3 is a private readiness pipe from this child to its parent; stdout/stderr are inherited test channels.
  return spawn(process.execPath, [__filename, ...childArgs], { stdio: ["ignore", "inherit", "inherit", "pipe"], ...extra });
}
function ready(proc) {
  return new Promise((resolve, reject) => {
    proc.stdio[3].once("data", (d) => resolve(String(d).trim()));
    proc.once("exit", (c) => reject(new Error("child exited before ready: " + c)));
  });
}

async function main() {
  if (mode === "write-fd") {
    try { fs.writeSync(Number(args[0]), args[1]); process.exit(0); }
    catch (error) { process.exit(error && error.code === "EBADF" ? 3 : 4); }
  }
  if (mode === "open-write") { say("OPEN " + code(() => fs.closeSync(fs.openSync(args[0], "w")))); return; }
  if (mode === "link") { say("LINK " + code(() => fs.linkSync(args[0], args[1]))); return; }
  if (mode === "grand") {
    const [label, dir, src] = args;
    say(`HB ${label} ${process.pid}`);
    say(`LINK ${label} ${code(() => fs.linkSync(src, path.join(dir, label + ".webp")))}`);
    say(`CREATE ${label} ${code(() => fs.writeFileSync(path.join(dir, label + "-new.webp"), "x"))}`);
    try { fs.writeSync(3, "ready " + process.pid); fs.closeSync(3); } catch { /* parent gone */ }
    setInterval(() => say(`HB ${label} ${process.pid}`), 100);
    return;
  }
  if (mode === "middle") {
    const [dir, src] = args;
    const orphan = child(["grand", "orphan", dir, src]);
    const value = await ready(orphan);
    orphan.unref(); orphan.stdio[3].destroy();
    fs.writeSync(3, value); fs.closeSync(3);
    process.exit(0); // orphan the grandchild: it reparents to the nearest subreaper
  }
  if (mode === "tree") {
    const [dir, src, behaviour] = args;
    const detached = child(["grand", "setsid", dir, src], { detached: true });
    const middle = child(["middle", dir, src]);
    const [a, b] = await Promise.all([ready(detached), ready(middle)]);
    detached.unref(); detached.stdio[3].destroy(); middle.unref();
    say(`TREE_READY ${a} | ${b} fault_env=${process.env.F2_LAUNCHER_FAULT ? "present" : "absent"}`);
    if (behaviour === "kill-supervisor") { process.kill(process.ppid, "SIGKILL"); setInterval(() => {}, 1000); return; }
    if (behaviour === "spoof") {
      const forged = `F2PA1 COMPLETE supervisor=${process.ppid} worker_status=0`;
      say(forged); try { fs.writeSync(2, forged + "\n"); } catch { /* ignore */ }
      const fd4 = code(() => fs.writeSync(4, forged + "\n"));
      const procFd = code(() => { const fd = fs.openSync(`/proc/${process.ppid}/fd/4`, "w"); fs.writeSync(fd, forged + "\n"); fs.closeSync(fd); });
      say(`SPOOF fd4=${fd4} procfd=${procFd}`);
    }
    process.exit(0);
  }
  throw new Error("unknown mode " + mode);
}
main().catch((error) => { say("FIXTURE_ERROR " + String(error && error.message)); process.exit(5); });
