'use strict';
// Stage 5 release gate: offline proofs are NOT evidence of real W2 writer adoption.
// This intentionally blocks until durable operation identity is wired to actual W2 upload.
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const route=fs.readFileSync(path.join(root,'apps/api/src/routes/productPhotoUpload.ts'),'utf8');
const guard=fs.readFileSync(path.join(root,'apps/api/src/services/photoOwnershipFencing.ts'),'utf8');
const evidence={
  routeCarriesDurableOperationToken:/\b(operationToken|idempotencyKey)\b/.test(route),
  routeCarriesGenerationFence:/\b(expectedGeneration|fencingGeneration|operationGeneration)\b/.test(route),
  routeExplicitlyChecksOwnership:/\b(photoOwnershipFencing|claimPhotoOperation|assertPhotoOperationFence)\b/.test(route),
  fencingSourceIsPresent:guard.includes('refuseUnadoptedPhotoWriter')
};
console.log(JSON.stringify({gate:'W2_LIVE_ADOPTION_REQUIRED',evidence},null,2));
if(!Object.values(evidence).every(Boolean)){
  console.error('BLOCKED: independent W2 SQLite/PostgreSQL identity proofs are not wired to live product-photo upload; production adoption must not be inferred.');
  process.exitCode=1;
}
