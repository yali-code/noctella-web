import fs from "node:fs/promises";
import os from "node:os";
import {createReadStream} from "node:fs";
import {createHash} from "node:crypto";
import path from "node:path";

import { generateFixtures } from "../../apps/api/src/scripts/photoMemoryBenchmark/fixtures";
import { PROFILES } from "../../apps/api/src/scripts/photoMemoryBenchmark/scenarios";
import { createRequire } from "node:module";
const sharp = createRequire(new URL("../../apps/api/package.json", import.meta.url))("sharp");
const { runCombinedScenario } = createRequire(import.meta.url)("../../apps/api/dist/scripts/sharedImageResourceProbe.js");
const { runScenario } = createRequire(import.meta.url)("../../apps/api/dist/scripts/photoUploadResourceProbe.js");
import { FIXTURES, selectedScenarios, parseEvents, validateLimits, validateCombinedMode } from "./policy.mjs";

async function cgroup() {
  const value = async (name: string) => (await fs.readFile("/sys/fs/cgroup/" + name, "utf8")).trim();
  return {
    max: Number(await value("memory.max")), swapMax: Number(await value("memory.swap.max")),
    current: Number(await value("memory.current")), peak: Number(await value("memory.peak")),
    events: parseEvents(await value("memory.events")),
  };
}
async function main() {
  const mode = process.argv[2];
  if (mode === "generate") {
    const needed = new Set(selectedScenarios(true, process.env.CASE_PROFILE ?? "full").flatMap((s: { fixtures: string[] }) => s.fixtures));
    const specs = PROFILES.full.fixtures.filter((spec) => FIXTURES.includes(spec.name) && needed.has(spec.name));
    const fixtures = await generateFixtures(specs, "/fixtures");
    await fs.writeFile("/fixtures/fixtures.json", JSON.stringify(fixtures, null, 2), { flag: "wx" });
    return;
  }
  const limits = await cgroup();
  const networkNames = Object.keys(os.networkInterfaces());
  validateLimits(limits, networkNames);
  const environment = { node: process.version, sharp: sharp.versions, platform: process.platform, arch: process.arch, kernel: os.release(), cpus: os.cpus().length, sharpConcurrency: sharp.concurrency(), cache: sharp.cache(), networkNames, limits };
  if (process.version !== "v20.20.0" || sharp.versions.sharp !== "0.34.5") throw new Error("Unexpected pinned Node/Sharp version");
  if (mode === "preflight") {
    await fs.writeFile("/evidence/preflight.json", JSON.stringify(environment, null, 2));
    return;
  }
  if (mode !== "run") throw new Error("Unknown isolated agent mode");
  const config = JSON.parse(await fs.readFile("/work/config.json", "utf8"));
  if(config.scenario.path === "combined"){
    const fixture=config.fixtures.find((f:any)=>f.name===config.scenario.fixtures[0]);
    if(!fixture)throw Error("Combined fixture missing");
    const hash=createHash("sha256");for await(const chunk of createReadStream(path.join("/fixtures",path.basename(fixture.file))))hash.update(chunk);
    const mode=validateCombinedMode(config.scenario,process.env,fixture,hash.digest("hex"));
    await fs.writeFile("/evidence/measurement-mode.json",JSON.stringify(mode,null,2));
  }
  const result = config.scenario.path === "combined" ? await runCombinedScenario(config) : await runScenario(config);
  await fs.writeFile("/evidence/result.json", JSON.stringify(result, null, 2));
}
main().catch((error) => { console.error(String(error)); process.exitCode = 2; });
