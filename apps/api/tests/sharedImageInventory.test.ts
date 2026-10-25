import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
it("requires explicit review when a production Sharp entry file is added",async()=>{
 const root=path.resolve(__dirname,"../src"),files:string[]=[];
 async function walk(dir:string){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())await walk(file);else if(file.endsWith(".ts") && /\bsharp\(/.test(await fs.readFile(file,"utf8")))files.push(path.relative(root,file).replaceAll("\\","/"));}}
 await walk(root);
 expect(files.sort()).toEqual(["integrations/instagram/instagramDerivativeRecipe.ts","integrations/instagram/mediaPreparation.ts","services/aiIntakePhotoStorage.ts","services/aiIntakeStagedExposure.ts","services/photoProcessingRecipe.ts","services/photoStorage.ts","services/stagedProductPhotoStorage.ts"]);
 for(const file of files){if(/instagramDerivativeRecipe\.ts$/.test(file))continue;const text=await fs.readFile(path.join(root,file),"utf8");expect(text).toContain(/photoProcessingRecipe\.ts$/.test(file)?"assertImageOperationOwned":"runImageOperation");}
 // P5: instagramDerivativeRecipe.ts keeps main's original admission-free recipe; its explicitly listed production importers
 // and their admission are enforced by scripts/photo-writer-adoption/fencing-disposition.test.cjs and, at runtime, by
 // tests/instagramRecipeAdmission.test.ts.
});
