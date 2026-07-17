import { copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export async function copyBuildAsset(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination) {
    console.error("Usage: node scripts/copy-build-asset.mjs <source> <destination>");
    process.exitCode = 1;
  } else {
    try {
      await copyBuildAsset(source, destination);
    } catch (error) {
      console.error(`Failed to copy required build asset from "${source}" to "${destination}":`, error);
      process.exitCode = 1;
    }
  }
}
