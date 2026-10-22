'use strict';
// P2-2B3D6: SIGKILL target - enters a legacy-writer lease and blocks (a writer killed mid-mutation).
Object.assign(process.env, { NODE_ENV: 'test', PRODUCT_PHOTO_DISK_STAGING_ENABLED: 'true' });
const { DevelopmentLegacyWriterGate } = require('../../apps/api/src/services/developmentLegacyWriterGate.ts');

const [root, writer] = process.argv.slice(2);
const lease = new DevelopmentLegacyWriterGate(root).enter(writer);
lease.checkpoint();
process.stdout.write(`inside-lease ${lease.id}\n`);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
