'use strict';
// P2-2B3D5: SIGKILL target. Claims and seals an operation on the disposable SQLite file, publishes
// the canonical pair with no-overwrite links, then blocks BEFORE the finalization transaction.
const fs = require('node:fs');
const path = require('node:path');
const { sqliteEngine, contract } = require('./contract.cjs');

const [root, intentJson, artifactJson] = process.argv.slice(2);
const intent = JSON.parse(intentJson), artifact = JSON.parse(artifactJson);
(async () => {
  const engine = sqliteEngine(path.join(root, 'app.sqlite'));
  const c = contract(engine);
  const t = await c.claim(intent);
  await c.seal(t, intent.now + 1, { ...artifact, generation: t.generation });
  for (const [file, key] of [['main.webp', intent.mainKey], ['thumb.webp', intent.thumbKey]]) fs.linkSync(path.join(root, 'sealed', file), path.join(root, 'canonical', key));
  process.stdout.write('published-before-finalize\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
})();
