'use strict';
// P2-2B3D3 (#396): SIGKILL target. Opens the disposable SQLite authority and blocks inside the
// #406 capability's exclusive operation marker section (after the marker is durably written).
const path = require('node:path');
const { open, adapter } = require('../photo-storage-capability/fixture.cjs');
const { DevelopmentPhotoStorageCapability } = require('../../apps/api/src/services/developmentPhotoStorageCapability.ts');

const [root, hash] = process.argv.slice(2);
(async () => {
  const { p } = await open('sqlite', root, undefined, hash);
  const authority = adapter(p, hash);
  const blocking = { ...authority, create: () => { process.stdout.write('inside-marker\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000); return null; } };
  const cap = new DevelopmentPhotoStorageCapability(blocking, path.join(root, 'private'), path.join(root, 'canonical'));
  await cap.begin('killed-op', 'k', 'claim-k', 100, 100);
})();
