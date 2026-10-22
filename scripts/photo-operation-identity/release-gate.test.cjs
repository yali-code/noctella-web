'use strict';
// Stage 5 regression: a green Stage 4 suite cannot override blocked live W2 adoption.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const workflow=fs.readFileSync(path.resolve(__dirname,'../../.github/workflows/photo-master-stage1-4.yml'),'utf8');
test('central photo release acceptance depends on real W2 adoption proof',()=>{
  const aggregate=workflow.split(/^  photo-master-acceptance:\s*$/m)[1]?.split(/^  [a-z][a-z0-9-]*:\s*$/m)[0];
  assert.ok(aggregate,'missing central acceptance');
  const needs=aggregate.split(/^    needs:\s*$/m)[1]?.split(/^    runs-on:/m)[0] ?? '';
  assert.match(needs,/^      - w2-live-adoption-gate$/m,'cannot report photo-master-acceptance PASS if W2 is unadopted');
  assert.match(aggregate,/if: always\(\)/,'must evaluate when upstream fails');
  assert.match(aggregate,/job\.result!=="success"/,'must fail for failed, skipped or cancelled gates');
});
