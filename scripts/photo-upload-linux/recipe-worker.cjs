// Offline experiment only. No production import or HTTP-selectable mode.
const { spawn } = require('node:child_process');
function runBoundedNode(args, { timeoutMs = 55000, signal, maxOutputBytes = 8192 } = {}) {
 return new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(Error('Worker aborted')); return; }
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', failure, timer, killTimer;
  const stop = message => {
   if (failure) return;
   failure = Error(message); child.kill('SIGTERM');
   killTimer = setTimeout(() => child.kill('SIGKILL'), 250);
  };
  const abort = () => stop('Worker aborted');
  signal?.addEventListener('abort', abort, { once: true });
  timer = setTimeout(() => stop('Worker timeout'), timeoutMs);
  child.stdout.on('data', chunk => {
   if (output.length + chunk.length > maxOutputBytes) stop('Worker output budget');
   else output += chunk.toString();
  });
  child.stderr.resume();
  child.once('error', () => { failure = Error('Worker spawn failed'); });
  // Physical close, including pipe closure, must precede admission release.
  child.once('close', (code, termination) => {
   clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
   if (failure) { reject(failure); return; }
   if (code !== 0 || termination) { reject(Error('Worker failed: ' + code + ' ' + termination)); return; }
   try { resolve(JSON.parse(output)); } catch { reject(Error('Worker invalid result')); }
  });
 });
}
module.exports = {
 runBoundedNode,
 runRecipe: (input, output, sharpModule) => runBoundedNode([__filename, 'convert', input, output, sharpModule]),
};
if (require.main === module) {
 (async () => {
  const fs = require('node:fs');
  const [mode, input, output, sharpModule] = process.argv.slice(2);
  if (mode !== 'convert' || process.platform !== 'linux' ||
      !new RegExp('^/work/[.]ai-intake-upload-ingress/request-[^/]+/input$').test(input) ||
      !new RegExp('^/work/intake/[a-f0-9-]+[.]webp$').test(output)) throw Error('Disposable synthetic paths required');
  const read = name => Number(fs.readFileSync('/sys/fs/cgroup/' + name, 'utf8'));
  if (read('memory.max') !== 536870912 || read('memory.swap.max') !== 0) throw Error('Worker limits not enforced');
  const self = fs.readFileSync('/proc/self/cgroup', 'utf8');
  const parent = fs.readFileSync('/proc/' + process.ppid + '/cgroup', 'utf8');
  if (self !== parent) throw Error('Worker escaped parent cgroup');
  const trace = phase => fs.appendFileSync('/evidence/recipe-worker.ndjson', JSON.stringify({ phase, time: Date.now(), pid: process.pid, ppid: process.ppid, cgroup: self, memory: process.memoryUsage(), current: read('memory.current'), peak: read('memory.peak') }) + '\n');
  trace('start');
  const processor = require(sharpModule);
  const result = await processor(input, { failOn: 'error' }).rotate().webp({ quality: 86 }).toFile(output);
  trace('end'); process.stdout.write(JSON.stringify(result));
 })().catch(() => { process.stderr.write('Synthetic recipe worker failed'); process.exitCode = 2; });
}
