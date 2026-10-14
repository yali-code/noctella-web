// Synthetic diagnostic only. Preparation/fidelity analysis are outside measured codec cgroups.
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { createHash } = require('node:crypto');
const processor = require('/app/apps/api/node_modules/sharp');
const { compareSamples } = require('./codec-metrics.cjs');
const hash = async file => { const h = createHash('sha256'); for await (const c of createReadStream(file)) h.update(c); return h.digest('hex'); };
async function main() {
 if (process.platform !== 'linux') throw Error('Linux disposable diagnostic only');
 const mode = process.argv[2];
 if (mode === 'prepare') {
  const fixtures = JSON.parse(await fs.readFile('/fixtures/fixtures.json', 'utf8'));
  const fixture = fixtures.find(f => f.name === 'jpeg-near-limit');
  const input = '/fixtures/' + require('node:path').basename(fixture.file);
  if (await hash(input) !== '2f2f90eb7060b031815c5afc8503e2914b2e7eb398b29eabfd23330443c441c7') throw Error('Fixture changed');
  const { data, info } = await processor(input, { failOn: 'error' }).rotate().raw().toBuffer({ resolveWithObject: true });
  await fs.writeFile('/codec/input.rgb', data, { flag: 'wx' });
  if (info.width !== 6000 || info.height !== 4000 || info.channels !== 3 || info.size !== 72000000) throw Error('RGB diagnostic recipe changed');
  await processor(input, { failOn: 'error' }).rotate().webp({ quality: 86 }).toFile('/codec/reference.webp');
  await fs.writeFile('/codec/recipe.json', JSON.stringify({ fixture, inputSha: await hash(input), raw: info, rawSha: await hash('/codec/input.rgb'), referenceSha: await hash('/codec/reference.webp'), versions: processor.versions, concurrency: processor.concurrency(), cache: processor.cache(), scope: 'Codec-only diagnostic; not full API acceptance' }, null, 2));
 } else if (mode === 'compare') {
  const reference = await processor('/codec/reference.webp').raw().toBuffer({ resolveWithObject: true });
  const results = [];
  for (const name of ['control', 'low-memory']) {
   const file = '/codec/' + name + '/output.webp';
   try {
    const decoded = await processor(file).raw().toBuffer({ resolveWithObject: true });
    if (JSON.stringify(decoded.info) !== JSON.stringify(reference.info)) throw Error('Decoded geometry/channels changed');
    results.push({ name, sha256: await hash(file), bytes: (await fs.stat(file)).size, metadata: await processor(file).metadata(), ...compareSamples(reference.data, decoded.data) });
   } catch (error) { results.push({ name, error: String(error) }); }
  }
  await fs.writeFile('/codec/fidelity.json', JSON.stringify(results, null, 2));
 } else throw Error('Unknown diagnostic mode');
}
main().catch(error => { console.error(String(error)); process.exitCode=2; });
