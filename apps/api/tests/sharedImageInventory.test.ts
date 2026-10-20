import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
it("requires explicit review when a production Sharp entry file is added",async()=>{
 const root=path.resolve(__dirname,"../src"),files:string[]=[];
 async function walk(dir:string){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())await walk(file);else if(file.endsWith(".ts") && /\bsharp\(/.test(await fs.readFile(file,"utf8")))files.push(path.relative(root,file).replaceAll("\\","/"));}}
 await walk(root);
 expect(files.sort()).toEqual(["integrations/instagram/instagramDerivativeRecipe.ts","integrations/instagram/mediaPreparation.ts","services/aiIntakePhotoStorage.ts","services/aiIntakeStagedExposure.ts","services/photoProcessingRecipe.ts","services/photoStorage.ts","services/stagedProductPhotoStorage.ts"]);
 for(const file of files){const text=await fs.readFile(path.join(root,file),"utf8");expect(text).toContain(/(photoProcessingRecipe|instagramDerivativeRecipe).ts$/.test(file)?"assertImageOperationOwned":"runImageOperation");}
});
