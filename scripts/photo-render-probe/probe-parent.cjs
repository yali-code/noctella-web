'use strict';
// F2 Render probe — TRUSTED PARENT. Starts the reviewed launcher in its supported plain mode with the descriptor layout
// it validates (fd 0 = /dev/null, fd 1/2 = AF_UNIX stream sockets created by this process; nothing else inherited) and
// checks ACTUAL enforcement: the worker ran (fresh nonce), wrote inside the allowed directory, and was denied writes to
// a disposable sibling whose bytes stay unchanged. A sensitivity control runs the same worker WITHOUT the launcher and
// must succeed in writing its own disposable victim copy (proves the denial is Landlock, not file permissions).
// Only paths beneath <base> (inside the probe root) are created or written. No environment is printed.
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const [launcher, base, worker] = process.argv.slice(2);
if (!launcher || !base || !worker) { console.log('PROBE_LANDLOCK FAIL usage'); process.exit(2); }
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function setup(name) {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { mode: 0o700 });                 // refuses an existing directory
  const allowed = path.join(dir, 'allowed'), sibling = path.join(dir, 'sibling');
  fs.mkdirSync(allowed, { mode: 0o700 }); fs.mkdirSync(sibling, { mode: 0o700 });
  const victim = path.join(sibling, 'victim.bin');
  fs.writeFileSync(victim, crypto.randomBytes(64), { flag: 'wx', mode: 0o600 });
  return { allowed, sibling, victim, victimHash: sha(victim), nonce: crypto.randomUUID() };
}

function run(cmd, args) {
  return new Promise((resolve) => {
    // Minimal environment: PATH only. The launcher itself rejects any other inherited descriptor layout.
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
    let out = '', err = '';
    child.stdout.on('data', (d) => { if (out.length < 16384) out += d; });
    child.stderr.on('data', (d) => { if (err.length < 16384) err += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.once('error', (e) => { clearTimeout(timer); resolve({ code: null, signal: null, out, err: err + `\nSPAWN_ERROR ${e.code}` }); });
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, out, err }); });
  });
}
const lastJson = (text) => { try { return JSON.parse(text.trim().split('\n').pop()); } catch { return null; } };

(async () => {
  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); };

  // Sensitivity control: the same worker, unconfined, must be ABLE to write its victim.
  const c = setup('control');
  const control = await run(process.execPath, [worker, c.allowed, c.victim, c.sibling, c.nonce]);
  const cr = lastJson(control.out);
  check('control.worker-ran', cr && cr.nonce === c.nonce, cr && cr.pid);
  check('control.unconfined-write-succeeds', cr && cr.victimWrite === 'WRITTEN' && sha(c.victim) !== c.victimHash, cr && cr.victimWrite);

  // Confined run through the reviewed launcher (plain mode): writable only beneath <allowed>.
  const l = setup('confined');
  const confined = await run(launcher, [l.allowed, '--', process.execPath, worker, l.allowed, l.victim, l.sibling, l.nonce]);
  const enforced = /^LANDLOCK_ENFORCED abi=(\d+) uid=(\d+)/m.exec(confined.err);
  const refused = /^(LAUNCHER_REFUSED .*|LANDLOCK_ABI_3_REQUIRED .*)$/m.exec(confined.err);
  const wr = lastJson(confined.out);
  const abi = enforced ? Number(enforced[1]) : null;
  check('launcher.exit-0', confined.code === 0 && !confined.signal, `code=${confined.code} signal=${confined.signal}${refused ? ' ' + refused[1] : ''}`);
  check('launcher.reported-abi>=3', abi !== null && abi >= 3, `abi=${abi}`);
  check('worker.ran-with-fresh-nonce', wr && wr.nonce === l.nonce && wr.pid !== process.pid, wr && `pid=${wr.pid}`);
  const allowedFile = path.join(l.allowed, `written-${l.nonce}.txt`);
  check('allowed.write-succeeded', wr && wr.allowedWrite === 'WRITTEN' && fs.existsSync(allowedFile) && fs.readFileSync(allowedFile, 'utf8') === l.nonce, wr && wr.allowedWrite);
  check('sibling.in-place-write-denied', wr && ['EACCES', 'EPERM'].includes(wr.victimWrite), wr && wr.victimWrite);
  check('sibling.bytes-unchanged', sha(l.victim) === l.victimHash, 'sha256 compared');
  check('sibling.create-denied', wr && ['EACCES', 'EPERM'].includes(wr.siblingCreate) && !fs.existsSync(path.join(l.sibling, 'created-by-worker')), wr && wr.siblingCreate);

  for (const k of checks) console.log(`PROBE_CHECK ${k.ok ? 'PASS' : 'FAIL'} ${k.name} ${k.detail ?? ''}`);
  const pass = checks.every((k) => k.ok);
  console.log(`PROBE_LANDLOCK ${pass ? 'PASS' : 'FAIL'} abi=${abi}`);
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.log(`PROBE_LANDLOCK FAIL ${String(e && e.message || e)}`); process.exit(1); });
