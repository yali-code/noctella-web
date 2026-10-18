/*
 * #472 F2 Step 3 OFFLINE worker command server. Normally started CONFINED by the Step 2 launcher (plain mode, Node IPC
 * on the verified fd 3). Each IPC command performs one action and replies { id, result } where result is "OK", a
 * value, or the error code. It owns its private source, may keep a retained read/write descriptor to it and may
 * create hardlink aliases of it — exactly the authority a stale or compromised worker retains.
 */
"use strict";
const fs = require("node:fs");

let retained = -1;
const attempt = (fn) => { try { const v = fn(); return v === undefined ? "OK" : v; } catch (e) { return e && e.code ? e.code : "ERR"; } };
const actions = {
  "write-file": ({ path, content }) => attempt(() => fs.writeFileSync(path, content)),
  "retain": ({ path }) => attempt(() => { retained = fs.openSync(path, "r+"); return retained; }),
  "write-retained": ({ offset, content }) => attempt(() => { fs.writeSync(retained, Buffer.from(content), 0, Buffer.byteLength(content), offset); }),
  "truncate-retained": ({ size }) => attempt(() => fs.ftruncateSync(retained, size)),
  "write-at": ({ path, offset, content }) => attempt(() => { const fd = fs.openSync(path, "r+"); try { fs.writeSync(fd, Buffer.from(content), 0, Buffer.byteLength(content), offset); } finally { fs.closeSync(fd); } }),
  "link": ({ from, to }) => attempt(() => fs.linkSync(from, to)),
  "replace": ({ path, content }) => attempt(() => { fs.writeFileSync(path + ".new", content); fs.renameSync(path + ".new", path); }),
  "rename": ({ from, to }) => attempt(() => fs.renameSync(from, to)),
  "open": ({ path, flags }) => attempt(() => { fs.closeSync(fs.openSync(path, flags)); }),
  "truncate": ({ path }) => attempt(() => fs.truncateSync(path, 0)),
  "unlink": ({ path }) => attempt(() => fs.unlinkSync(path)),
  "chmod": ({ path, mode }) => attempt(() => fs.chmodSync(path, mode)),
  "proc-fd-write": ({ pid, fd }) => attempt(() => { const own = fs.openSync(`/proc/${pid}/fd/${fd}`, "r+"); fs.writeSync(own, "X"); fs.closeSync(own); }),
  /** Identity probe: does ANY descriptor of this process refer to (dev, ino)? */
  "probe": ({ dev, ino }) => {
    for (const name of fs.readdirSync("/proc/self/fd")) {
      let st; try { st = fs.fstatSync(Number(name), { bigint: true }); } catch { continue; }
      if (String(st.dev) === dev && String(st.ino) === ino) return "FOUND fd=" + name;
    }
    return "FD_ABSENT";
  },
};
process.on("message", (m) => {
  const handler = actions[m && m.cmd];
  process.send({ id: m.id, result: handler ? handler(m.args || {}) : "UNKNOWN_COMMAND" });
});
process.send({ ready: process.pid });
