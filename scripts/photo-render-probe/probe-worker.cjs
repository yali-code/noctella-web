'use strict';
// F2 Render probe — WORKER (runs inside the Landlock launcher, or unconfined as the sensitivity control).
// Touches ONLY the disposable paths it is given; prints exactly one JSON line. No environment is read or printed.
const fs = require('node:fs');
const path = require('node:path');

const [allowedDir, victimFile, siblingDir, nonce] = process.argv.slice(2);
const attempt = (fn) => { try { fn(); return 'WRITTEN'; } catch (e) { return String((e && e.code) || e); } };

const result = {
  nonce,
  pid: process.pid,
  ppid: process.ppid,
  // Allowed subtree: must succeed.
  allowedWrite: attempt(() => fs.writeFileSync(path.join(allowedDir, `written-${nonce}.txt`), nonce, { flag: 'wx', mode: 0o600 })),
  // Outside the allowed subtree: an existing file (in-place write) and a new file.
  victimWrite: attempt(() => { const fd = fs.openSync(victimFile, 'r+'); try { fs.writeSync(fd, 'TAMPERED', 0); } finally { fs.closeSync(fd); } }),
  siblingCreate: attempt(() => fs.writeFileSync(path.join(siblingDir, 'created-by-worker'), nonce, { flag: 'wx', mode: 0o600 })),
};
process.stdout.write(JSON.stringify(result) + '\n');
