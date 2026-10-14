// Decoded sample comparison; callers must establish matching geometry/channel semantics.
function compareSamples(reference, candidate) {
 if (!reference.length || reference.length !== candidate.length) throw Error('Decoded sample sizes differ or are empty');
 let squared=0, maximum=0, different=0;
 for(let i=0;i<reference.length;i++) {
  const delta=Math.abs(reference[i]-candidate[i]); squared+=delta*delta; maximum=Math.max(maximum,delta); if(delta)different++;
 }
 const mse=squared/reference.length;
 return { decodedSampleCount:reference.length, differingSamples:different, maxAbsoluteError:maximum, mse, psnrDb:mse===0?'infinite':10*Math.log10(255*255/mse), decodedIdentical:different===0 };
}
module.exports={compareSamples};
