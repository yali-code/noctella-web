'use strict';
// Read-only, source-tree acceptance guard. A pinned reference benchmark is not
// evidence that the candidate branch contains the W3 real original-source writer.
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const files={
  feature:path.join(root,'apps/api/src/services/aiIntakeOriginalSourceStaging.ts'),
  keys:path.join(root,'apps/api/src/services/aiIntakeStagedKey.ts'),
  storage:path.join(root,'apps/api/src/services/aiIntakePhotoStorage.ts'),
  workload:path.join(root,'scripts/photo-upload-linux/policy.mjs'),
  probe:path.join(root,'apps/api/src/scripts/sharedImageResourceProbe.ts')
};
const read=p=>fs.existsSync(p)?fs.readFileSync(p,'utf8'):'';
const evidence={
  featureFlag:read(files.feature).includes('AI_INTAKE_ORIGINAL_SOURCE_STAGING_ENABLED'),
  originalKeys:read(files.keys).includes('originalSourceKeyParts'),
  realStorageCall:read(files.storage).includes('aiIntakeOriginalSourceStagingEnabled()'),
  candidateScenario:read(files.workload).includes('combined-original-source'),
  candidateProbe:read(files.probe).includes('aiIntakeOriginalSource')
};
console.log(JSON.stringify({gate:'W3_CANDIDATE_ORIGINAL_SOURCE_INTEGRATION',candidateSha:process.env.GITHUB_SHA||'local',evidence},null,2));
if(Object.values(evidence).some(v=>!v)){
  console.error('BLOCKED: W3 original-source integration not present in current candidate; pinned #422 reference evidence is not transferable.');
  process.exitCode=1;
}
